import type { BvnkBankFundingDetails, SdpEnvironment } from "@sdp/types";
import { getDb } from "@/db";
import { createCounterpartiesRepository } from "@/db/repositories";
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";
import { AppError, badRequest, internalError, providerNotConfigured } from "@/lib/errors";
import { readRecord, readString } from "@/lib/json";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  type BvnkCustomerResolution,
  type BvnkOnrampPaymentRuleState,
  isBvnkCustomerVerified,
  isBvnkWalletActive,
  parseBvnkOfframpWalletName,
  parseBvnkOnrampWalletName,
  pendingBvnkOnrampPaymentRuleKeys,
  readBvnkCustomer,
  readBvnkOfframpReference,
  readBvnkOnrampPaymentRuleState,
  withBvnkOfframpWalletStatus,
  withBvnkOnrampPaymentRuleState,
} from "@/lib/ramps/providers/bvnk/provider-data";
import type { RampRuntimeContext, RampWebhookValidationContext } from "@/lib/ramps/types";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { ensureBvnkPaymentRule } from "@/routes/payments/handlers/ramps/bvnk";
import type { AppContext, WebhookProcessor } from "./processor";

export type BvnkWebhookEvent =
  | {
      kind: "ledger:v2:wallet:status-change";
      customerReference?: string;
      walletId?: string;
      walletName?: string;
      walletStatus?: string;
      bankAccount?: BvnkBankFundingDetails;
    }
  | {
      kind: "bvnk:ledger:wallet:create";
      customerReference?: string;
      walletId?: string;
      walletName?: string;
      walletStatus?: string;
      bankAccount?: BvnkBankFundingDetails;
    }
  | {
      kind: "bvnk:customers:status-change";
      customerReference?: string;
      customerStatus?: string;
    }
  | {
      kind: "bvnk:platform:customer:update";
      customerReference?: string;
      verificationUrl?: string;
    }
  | {
      kind: "bvnk:payment:payin:status-change";
      customerReference?: string;
      walletId?: string;
      status?: string;
      amount?: string;
    }
  | {
      kind:
        | "bvnk:payment:channel:transaction-detected"
        | "bvnk:payment:channel:transaction-confirmed";
      transferId?: string;
      channelId?: string;
      transactionId?: string;
      transactionHash?: string;
      status?: string;
      paidCurrency?: string;
      paidAmount?: string;
      displayCurrency?: string;
      displayAmount?: string;
      walletCurrency?: string;
      walletAmount?: string;
      feeCurrency?: string;
      feeAmount?: string;
    }
  | { kind: "ignore"; event: string };

const HANDLED_BVNK_EVENTS = {
  "ledger:v2:wallet:status-change": true,
  "bvnk:ledger:wallet:create": true,
  "bvnk:customers:status-change": true,
  "bvnk:platform:customer:update": true,
  "bvnk:payment:payin:status-change": true,
  "bvnk:payment:channel:transaction-detected": true,
  "bvnk:payment:channel:transaction-confirmed": true,
} as const satisfies Record<Exclude<BvnkWebhookEvent, { kind: "ignore" }>["kind"], true>;

function isHandledBvnkEvent(event: string): boolean {
  return Object.hasOwn(HANDLED_BVNK_EVENTS, event);
}

interface BvnkWebhookFiatWallet {
  id?: string;
  name?: string;
  status?: string;
  bankAccount?: BvnkBankFundingDetails;
}

function webhookRampContext(c: AppContext, environment: SdpEnvironment): RampRuntimeContext {
  return { env: c.env as unknown as Record<string, string | undefined>, mode: environment };
}

function parseBvnkLedgersBankAccount(
  data: Record<string, unknown>
): BvnkBankFundingDetails | undefined {
  const ledgers = Array.isArray(data.ledgers) ? data.ledgers : [];
  for (const entry of ledgers) {
    const ledger = readRecord(entry);
    if (!ledger) {
      continue;
    }
    const accountNumber = readString(ledger.accountNumber);
    if (accountNumber) {
      return {
        accountNumber,
        code: readString(ledger.code),
        accountNumberFormat: readString(ledger.accountNumberFormat),
      };
    }
  }
  return undefined;
}

function parseBvnkWebhookFiatWallet(payload: unknown): BvnkWebhookFiatWallet {
  const data = readRecord(payload);
  const id = data && readString(data.id);
  if (!data || !id) {
    throw badRequest("BVNK wallet response is missing an id");
  }
  const name = readString(data.name);
  const status = readString(data.status);
  const instruments = Array.isArray(data.paymentInstruments) ? data.paymentInstruments : [];
  for (const entry of instruments) {
    const inst = readRecord(entry);
    if (!inst || readString(inst.type) !== "FIAT") continue;
    const bank = readRecord(inst.bankDetails);
    return {
      id,
      name,
      status,
      bankAccount: {
        accountNumber: readString(inst.accountNumber),
        code: readString(bank?.bic),
        paymentReference: readString(inst.remittanceInformationPrefix),
        bankName: readString(bank?.name),
      },
    };
  }
  return { id, name, status };
}

function readBvnkAmount(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}

async function updateBvnkOnrampPaymentRuleState(
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  onrampPaymentRuleKey: string,
  paymentRule: Partial<BvnkOnrampPaymentRuleState>
): Promise<void> {
  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    providerData: withBvnkOnrampPaymentRuleState(
      counterparty.provider_data,
      onrampPaymentRuleKey,
      paymentRule
    ),
  });
}

async function handleProviderOnrampSettlementWebhook(
  c: AppContext,
  event: Extract<BvnkWebhookEvent, { kind: "bvnk:payment:payin:status-change" }>
): Promise<void> {
  if (event.status !== "COMPLETED" || !event.customerReference || !event.walletId) {
    return;
  }
  const repo = createCounterpartiesRepository(c.env);
  const counterparty = await repo.findActiveCounterpartyByBvnkCustomerReference(
    event.customerReference
  );
  if (!counterparty) {
    throw internalError(
      `BVNK webhook customer ${event.customerReference} was not found or is not active`
    );
  }
  // Single guarded UPDATE: the status exclusion is on the write itself (not just the
  // lookup), so a transfer canceled in the race window can't be reopened to completed.
  await getDb(c.env)
    .prepare(
      `UPDATE payment_transfers
       SET status = 'completed',
           amount = CASE WHEN ?::boolean THEN ? ELSE amount END,
           fiat_amount = CASE WHEN ?::boolean THEN ? ELSE fiat_amount END,
           updated_at = ?
       WHERE id = (
         SELECT id
         FROM payment_transfers
         WHERE provider = 'bvnk'
           AND type = 'onramp'
           AND counterparty_id = ?
           AND provider_data->'bvnk'->>'fundingWalletId' = ?
           AND status NOT IN ('completed', 'failed', 'expired', 'canceled')
         ORDER BY created_at DESC
         LIMIT 1
       )
         AND status NOT IN ('completed', 'failed', 'expired', 'canceled')`
    )
    .bind(
      event.amount !== undefined,
      event.amount ?? null,
      event.amount !== undefined,
      event.amount ?? null,
      new Date().toISOString(),
      counterparty.id,
      event.walletId
    )
    .run();
}

async function applyBvnkCustomerRequirementWebhook(
  c: AppContext,
  environment: SdpEnvironment,
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  event: Extract<
    BvnkWebhookEvent,
    { kind: "bvnk:customers:status-change" | "bvnk:platform:customer:update" }
  >
): Promise<void> {
  const current = readBvnkCustomer(counterparty.provider_data);
  const customer: Partial<
    Pick<BvnkCustomerResolution, "status" | "verificationStatus" | "verificationUrl">
  > = {};
  if (event.kind === "bvnk:customers:status-change" && event.customerStatus) {
    customer.status = event.customerStatus.toUpperCase();
  }
  if (event.kind === "bvnk:platform:customer:update" && event.verificationUrl) {
    customer.verificationUrl = event.verificationUrl;
  }
  const nextStatus = typeof customer.status === "string" ? customer.status : current.status;
  const nextUrl =
    typeof customer.verificationUrl === "string"
      ? customer.verificationUrl
      : current.verificationUrl;
  if (!nextUrl && !isBvnkCustomerVerified(nextStatus)) {
    if (!current.customerReference) {
      return;
    }
    const latest = await RAMP_PROVIDER_CLIENTS.bvnk.getBvnkCustomer(
      webhookRampContext(c, environment),
      { reference: current.customerReference }
    );
    customer.status = latest.status.toUpperCase();
    customer.verificationStatus = latest.verificationStatus;
    if (latest.verificationUrl) customer.verificationUrl = latest.verificationUrl;
  }
  if (Object.keys(customer).length === 0) {
    return;
  }
  await repo.upsertBvnkCustomerProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    customer,
  });
}

async function provisionPendingBvnkOnramps(
  c: AppContext,
  repo: CounterpartiesRepository,
  environment: SdpEnvironment,
  counterparty: CounterpartyRow
): Promise<void> {
  const ctx = webhookRampContext(c, environment);
  const currentCounterparty = await repo.findActiveCounterpartyById(counterparty.id);
  if (!currentCounterparty) {
    throw internalError(
      `BVNK webhook counterparty ${counterparty.id} was not found or is not active`
    );
  }
  if (!isBvnkCustomerVerified(readBvnkCustomer(currentCounterparty.provider_data).status)) {
    return;
  }
  const pendingKeys = pendingBvnkOnrampPaymentRuleKeys(currentCounterparty.provider_data);
  for (const key of pendingKeys) {
    const reloadedCounterparty = await repo.findActiveCounterpartyById(counterparty.id);
    if (!reloadedCounterparty) {
      throw internalError(
        `BVNK webhook counterparty ${counterparty.id} was not found or is not active`
      );
    }
    const entry = readBvnkOnrampPaymentRuleState(reloadedCounterparty.provider_data, key);
    if (!entry.request || entry.ruleId) {
      continue;
    }
    try {
      await ensureBvnkPaymentRule(
        c,
        ctx,
        reloadedCounterparty,
        reloadedCounterparty.project_id,
        readBvnkCustomer(reloadedCounterparty.provider_data),
        entry.request
      );
    } catch (error) {
      await updateBvnkOnrampPaymentRuleState(repo, reloadedCounterparty, key, {
        provisioningError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function handleProviderOnrampCounterpartyRequirementWebhook(
  c: AppContext,
  environment: SdpEnvironment,
  event: Extract<
    BvnkWebhookEvent,
    {
      kind:
        | "bvnk:customers:status-change"
        | "bvnk:platform:customer:update"
        | "ledger:v2:wallet:status-change"
        | "bvnk:ledger:wallet:create";
    }
  >
): Promise<void> {
  const repo = createCounterpartiesRepository(c.env);

  switch (event.kind) {
    case "bvnk:customers:status-change":
    case "bvnk:platform:customer:update": {
      if (!event.customerReference) {
        console.log(
          `[bvnk webhook] "${event.kind}" has no customer reference: ${JSON.stringify(event)}`
        );
        return;
      }
      const counterparty = await repo.findActiveCounterpartyByBvnkCustomerReference(
        event.customerReference
      );
      if (!counterparty) {
        throw internalError(
          `BVNK webhook customer ${event.customerReference} was not found or is not active`
        );
      }
      await applyBvnkCustomerRequirementWebhook(c, environment, repo, counterparty, event);
      await provisionPendingBvnkOnramps(c, repo, environment, counterparty);
      return;
    }
  }

  if (!event.walletName) {
    console.log(`[bvnk webhook] "${event.kind}" has no wallet name: ${JSON.stringify(event)}`);
    return;
  }
  const wallet = parseBvnkOnrampWalletName(event.walletName);
  const counterparty = await repo.findActiveCounterpartyById(wallet.counterpartyId);
  if (!counterparty) {
    throw internalError(
      `BVNK webhook counterparty ${wallet.counterpartyId} was not found or is not active`
    );
  }
  const bankAccount = event.bankAccount;
  const hasBankAccountNumber =
    bankAccount &&
    typeof bankAccount.accountNumber === "string" &&
    bankAccount.accountNumber.length > 0;
  if (event.walletStatus || hasBankAccountNumber) {
    const state: Partial<BvnkOnrampPaymentRuleState> = {};
    if (event.walletStatus) state.walletStatus = event.walletStatus;
    if (hasBankAccountNumber) state.bankAccount = bankAccount;
    await updateBvnkOnrampPaymentRuleState(repo, counterparty, wallet.onrampKey, state);
  }
  if (isBvnkWalletActive(event.walletStatus)) {
    await provisionPendingBvnkOnramps(c, repo, environment, counterparty);
  }
}

async function handleProviderOfframpCounterpartyRequirementWebhook(
  c: AppContext,
  event: Extract<
    BvnkWebhookEvent,
    { kind: "ledger:v2:wallet:status-change" | "bvnk:ledger:wallet:create" }
  >
): Promise<void> {
  if (!event.walletName || !event.walletStatus) {
    console.log(
      `[bvnk webhook] merchant off-ramp wallet event is missing name or status: ${JSON.stringify(event)}`
    );
    return;
  }

  const repo = createCounterpartiesRepository(c.env);
  const wallet = parseBvnkOfframpWalletName(event.walletName);
  const counterparty = await repo.findActiveCounterpartyById(wallet.counterpartyId);
  if (!counterparty) {
    throw internalError(
      `BVNK webhook counterparty ${wallet.counterpartyId} was not found or is not active`
    );
  }
  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    providerData: withBvnkOfframpWalletStatus(
      counterparty.provider_data,
      wallet.fiatCurrency,
      event.walletStatus
    ),
  });
}

type BvnkChannelTransactionEvent = Extract<
  BvnkWebhookEvent,
  {
    kind:
      | "bvnk:payment:channel:transaction-detected"
      | "bvnk:payment:channel:transaction-confirmed";
  }
>;

async function handleProviderOfframpSettlementWebhook(
  c: AppContext,
  event: BvnkChannelTransactionEvent
): Promise<void> {
  if (!event.transferId) {
    console.log(
      `[bvnk webhook] "${event.kind}" has no SDP off-ramp transfer reference: ${JSON.stringify(event)}`
    );
    return;
  }

  const status =
    event.kind === "bvnk:payment:channel:transaction-detected" ? "settling" : "completed";
  let fiatAmount: string | undefined;
  if (status === "completed") {
    fiatAmount = event.walletAmount ?? event.displayAmount;
  }
  await getDb(c.env)
    .prepare(
      `UPDATE payment_transfers
       SET status = ?,
           fiat_amount = CASE WHEN ?::boolean THEN ? ELSE fiat_amount END,
           updated_at = ?
       WHERE id = ?
         AND provider = 'bvnk'
         AND type = 'offramp'
         AND status NOT IN ('completed', 'failed', 'expired', 'canceled')`
    )
    .bind(
      status,
      fiatAmount !== undefined,
      fiatAmount ?? null,
      new Date().toISOString(),
      event.transferId
    )
    .run();
}

export class BvnkWebhookProcessor implements WebhookProcessor<unknown, BvnkWebhookEvent> {
  readonly provider = "bvnk";

  async verify(context: RampWebhookValidationContext): Promise<unknown> {
    const secret = (
      context.environment === "sandbox"
        ? context.env.BVNK_SANDBOX_WEBHOOK_SECRET
        : context.env.BVNK_WEBHOOK_SECRET
    )?.trim();
    if (!secret) {
      throw providerNotConfigured(
        context.environment === "sandbox"
          ? "BVNK sandbox webhook secret is not configured (BVNK_SANDBOX_WEBHOOK_SECRET)."
          : "BVNK webhook secret is not configured (BVNK_WEBHOOK_SECRET)."
      );
    }
    const signature = context.headers.get("x-signature")?.trim();
    if (!signature) {
      throw new AppError("UNAUTHORIZED", "BVNK webhook is missing the X-Signature header", {
        provider: this.provider,
      });
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(context.rawBody);
    } catch {
      throw badRequest("BVNK webhook body must be valid JSON", {
        provider: this.provider,
      });
    }
    const timestamp = payload.timestamp;
    await verifyWebhookSignature({
      provider: this.provider,
      signedPayload: context.rawBody,
      signature,
      algorithm: { type: "hmac-sha256", secret, encoding: "base64" },
      timestampSeconds: typeof timestamp === "string" ? Date.parse(timestamp) / 1000 : Number.NaN,
    });
    return payload;
  }

  parse(payload: unknown): BvnkWebhookEvent {
    const root = readRecord(payload);
    const event = readString(root?.event);
    if (!event) {
      throw badRequest("BVNK webhook is missing an event", { provider: this.provider });
    }
    const data = readRecord(root?.data);
    if (!data) {
      if (!isHandledBvnkEvent(event)) {
        return { kind: "ignore", event };
      }
      throw badRequest(`BVNK webhook "${event}" is missing a data object`, {
        provider: this.provider,
      });
    }

    switch (event) {
      case "bvnk:customers:status-change":
        return {
          kind: event,
          customerReference: readString(data.customerId),
          customerStatus: readString(data.status),
        };
      case "bvnk:platform:customer:update":
        return {
          kind: event,
          customerReference: readString(data.reference),
          verificationUrl: readString(readRecord(data.verification)?.url),
        };
      case "ledger:v2:wallet:status-change": {
        const wallet = parseBvnkWebhookFiatWallet(data);
        return {
          kind: event,
          customerReference: readString(readRecord(data.customer)?.id),
          walletId: wallet.id,
          walletName: wallet.name,
          walletStatus: readString(data.status),
          bankAccount: wallet.bankAccount,
        };
      }
      case "bvnk:ledger:wallet:create":
        return {
          kind: event,
          customerReference: readString(data.customerReference),
          walletId: readString(data.id),
          walletName: readString(data.walletName),
          walletStatus: readString(data.status),
          bankAccount: parseBvnkLedgersBankAccount(data),
        };
      case "bvnk:payment:payin:status-change":
        return {
          kind: event,
          customerReference: readString(data.customerReference),
          walletId: readString(readRecord(data.beneficiary)?.walletId),
          status: readString(data.status),
          amount: readBvnkAmount(readRecord(data.amount)?.value),
        };
      case "bvnk:payment:channel:transaction-detected":
      case "bvnk:payment:channel:transaction-confirmed": {
        const reference = readString(data.reference);
        return {
          kind: event,
          transferId: reference ? readBvnkOfframpReference(reference) : undefined,
          channelId: readString(data.channelId),
          transactionId: readString(data.uuid),
          transactionHash: readString(data.hash),
          status: readString(data.status),
          paidCurrency: readString(data.paidCurrency),
          paidAmount: readBvnkAmount(data.paidAmount),
          displayCurrency: readString(data.displayCurrency),
          displayAmount: readBvnkAmount(data.displayAmount),
          walletCurrency: readString(data.walletCurrency),
          walletAmount: readBvnkAmount(data.walletAmount),
          feeCurrency: readString(data.feeCurrency),
          feeAmount: readBvnkAmount(data.feeAmount),
        };
      }
      default:
        return { kind: "ignore", event };
    }
  }

  async process(
    c: AppContext,
    environment: SdpEnvironment,
    event: BvnkWebhookEvent
  ): Promise<void> {
    switch (event.kind) {
      case "ignore":
        console.log(`[bvnk webhook] ignoring event "${event.event}"`);
        return;
      case "bvnk:payment:payin:status-change":
        return handleProviderOnrampSettlementWebhook(c, event);
      case "bvnk:payment:channel:transaction-detected":
      case "bvnk:payment:channel:transaction-confirmed":
        return handleProviderOfframpSettlementWebhook(c, event);
      case "bvnk:customers:status-change":
      case "bvnk:platform:customer:update":
        return handleProviderOnrampCounterpartyRequirementWebhook(c, environment, event);
      case "ledger:v2:wallet:status-change":
      case "bvnk:ledger:wallet:create":
        if (event.walletName?.startsWith("sdp:offramp:")) {
          return handleProviderOfframpCounterpartyRequirementWebhook(c, event);
        }
        return handleProviderOnrampCounterpartyRequirementWebhook(c, environment, event);
    }
  }
}
