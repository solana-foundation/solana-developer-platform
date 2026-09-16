import type { BVNKWallet } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  type BvnkCustomerResolution,
  type BvnkOnrampPaymentRuleState,
  isBvnkCustomerVerified,
  isBvnkWalletActive,
  parseBvnkCustomerExternalReference,
  parseBvnkWalletName,
  pendingBvnkOnrampPaymentRuleKeys,
  readBvnkOfframpReference,
  readBvnkOnrampPaymentRuleState,
  withBvnkOfframpWalletStatus,
  withBvnkOnrampPaymentRuleState,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type { RampRuntimeContext, RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import {
  type BvnkBankFundingDetails,
  type SdpEnvironment,
  SETTLEABLE_RAMP_TRANSFER_STATUSES,
  TERMINAL_RAMP_TRANSFER_STATUSES,
} from "@sdp/types";
import type { z } from "zod";
import { getDb } from "@/db";
import {
  createSystemCounterpartiesRepository,
  createSystemPaymentsRepository,
} from "@/db/repositories";
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { AppError, badRequest, internalError, providerNotConfigured } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import {
  ensureBvnkPaymentRule,
  readBvnkCustomerLink,
  refreshBvnkCustomerAccount,
} from "@/routes/payments/handlers/ramps/bvnk";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import {
  BVNK_WEBHOOK_DATA,
  BVNK_WEBHOOK_ENVELOPE,
  type BvnkLedgerWalletCreateData,
  type BvnkLedgerWalletStatusChangeData,
  bvnkChannelTransactionSchema,
  bvnkCustomersStatusChangeSchema,
  bvnkLedgerWalletCreateSchema,
  bvnkLedgerWalletStatusChangeSchema,
  bvnkPayinStatusChangeSchema,
  bvnkPlatformCustomerStatusChangeSchema,
  bvnkPlatformCustomerUpdateSchema,
  parseBvnkWebhookData,
} from "./bvnk.schemas";
import type { WebhookProcessor } from "./processor";

type BvnkWalletWebhookEventName = "ledger:v2:wallet:status-change" | "bvnk:ledger:wallet:create";

export type BvnkWebhookEvent =
  | {
      kind: "bvnk:wallet:onramp";
      event: BvnkWalletWebhookEventName;
      wallet: Extract<BVNKWallet, { direction: "onramp" }>;
      walletStatus?: string;
      bankAccount?: BvnkBankFundingDetails;
    }
  | {
      kind: "bvnk:wallet:offramp";
      event: BvnkWalletWebhookEventName;
      wallet: Extract<BVNKWallet, { direction: "offramp" }>;
      walletStatus?: string;
      bankAccount?: BvnkBankFundingDetails;
    }
  | {
      kind: "bvnk:customers:status-change" | "bvnk:platform:customer:status-change";
      customerReference: string;
      customerStatus: string;
    }
  | {
      kind: "bvnk:platform:customer:update";
      customerReference: string;
      externalReference: string;
      customerStatus: string;
    }
  | {
      kind: "bvnk:payment:payin:status-change";
      customerReference?: string;
      walletId?: string;
      status?: string;
      amount?: string;
      paymentId?: string;
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
  "bvnk:platform:customer:status-change": true,
  "bvnk:platform:customer:update": true,
  "bvnk:payment:payin:status-change": true,
  "bvnk:payment:channel:transaction-detected": true,
  "bvnk:payment:channel:transaction-confirmed": true,
} as const satisfies Record<string, true>;

function isHandledBvnkEvent(event: string): event is keyof typeof HANDLED_BVNK_EVENTS {
  return Object.hasOwn(HANDLED_BVNK_EVENTS, event);
}

type BvnkCustomerWebhookEvent = Extract<
  BvnkWebhookEvent,
  {
    kind:
      | "bvnk:customers:status-change"
      | "bvnk:platform:customer:status-change"
      | "bvnk:platform:customer:update";
  }
>;

interface BvnkCustomerWebhookResolution {
  counterparty: CounterpartyRow;
  providerAccountId: string;
  customerReference: string;
}

function bvnkFiatWalletBankAccount(
  instruments: BvnkLedgerWalletStatusChangeData["paymentInstruments"]
): BvnkBankFundingDetails | undefined {
  const instrument = instruments?.find((entry) => entry.type === "FIAT");
  if (instrument === undefined) {
    return undefined;
  }
  return {
    accountNumber: instrument.accountNumber,
    code: instrument.bankDetails?.bic,
    paymentReference: instrument.remittanceInformationPrefix,
    bankName: instrument.bankDetails?.name,
  };
}

function bvnkLedgerBankAccount(
  ledgers: BvnkLedgerWalletCreateData["ledgers"]
): BvnkBankFundingDetails | undefined {
  const ledger = ledgers?.find((entry) => entry.accountNumber);
  if (ledger === undefined) {
    return undefined;
  }
  return {
    accountNumber: ledger.accountNumber,
    code: ledger.code,
    accountNumberFormat: ledger.accountNumberFormat,
  };
}

/**
 * Turns a wallet lifecycle payload into the on-ramp or off-ramp wallet arm by
 * parsing the SDP-generated wallet name. Wallets SDP did not name (no name, or
 * no `sdp:` prefix) belong to the merchant account and are acked as ignored;
 * an `sdp:` name that fails to parse propagates as an internal error.
 *
 * @param event - The BVNK wallet event name that carried the payload.
 * @param walletName - The wallet's name, when the payload carries one.
 * @param walletStatus - The wallet's status, when the payload carries one.
 * @param bankAccount - Funding details extracted from the payload, when present.
 * @returns The wallet arm for SDP-named wallets, or an ignore event.
 */
function parseBvnkWalletWebhookData(
  event: BvnkWalletWebhookEventName,
  walletName: string | undefined,
  walletStatus: string | undefined,
  bankAccount: BvnkBankFundingDetails | undefined
): Extract<BvnkWebhookEvent, { kind: "bvnk:wallet:onramp" | "bvnk:wallet:offramp" | "ignore" }> {
  if (walletName === undefined || !walletName.startsWith("sdp:")) {
    return { kind: "ignore", event };
  }
  const wallet = parseBvnkWalletName(walletName);
  const details = {
    event,
    ...(walletStatus === undefined ? {} : { walletStatus }),
    ...(bankAccount === undefined ? {} : { bankAccount }),
  };
  return wallet.direction === "offramp"
    ? { kind: "bvnk:wallet:offramp", wallet, ...details }
    : { kind: "bvnk:wallet:onramp", wallet, ...details };
}

function webhookRampContext(env: Env, environment: SdpEnvironment): RampRuntimeContext {
  return { env: env as unknown as Record<string, string | undefined>, mode: environment };
}

async function updateBvnkOnrampPaymentRuleState(
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  onrampPaymentRuleKey: string,
  paymentRule: Partial<BvnkOnrampPaymentRuleState>
): Promise<void> {
  // TODO(PRO-1823): Move BVNK on-ramp state to counterparty_provider_accounts.
  await repo.mutateProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    mutate: (providerData) =>
      withBvnkOnrampPaymentRuleState(providerData, onrampPaymentRuleKey, paymentRule),
  });
}

async function handleProviderOnrampSettlementWebhook(
  env: Env,
  event: Extract<BvnkWebhookEvent, { kind: "bvnk:payment:payin:status-change" }>
): Promise<void> {
  if (
    event.status !== "COMPLETED" ||
    !event.customerReference ||
    !event.walletId ||
    !event.amount
  ) {
    return;
  }
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyByProviderCustomerReference({
    provider: "bvnk",
    providerCustomerReference: event.customerReference,
  });
  if (!counterparty) {
    throw internalError(
      `BVNK webhook customer ${event.customerReference} was not found or is not active`
    );
  }
  const paymentAmount = event.amount;
  const payments = createSystemPaymentsRepository(env);
  // A replayed event that already settled a transfer must not re-match: the
  // settled row is excluded from the wallet+amount search, so a later
  // awaiting transfer with the same shape would become the "unique" match and
  // complete without a payment. The applied payin id on the settled row is
  // the dedupe marker.
  if (event.paymentId) {
    const alreadyApplied = await getDb(env)
      .prepare(
        `SELECT id
         FROM payment_transfers
         WHERE organization_id = ?
           AND project_id IS NOT DISTINCT FROM ?
           AND counterparty_id = ?
           AND provider = 'bvnk'
           AND provider_data->'bvnk'->>'appliedPayinId' = ?
         LIMIT 1`
      )
      .bind(counterparty.organization_id, counterparty.project_id, counterparty.id, event.paymentId)
      .first<{ id: string }>();
    if (alreadyApplied) {
      getLogger().info(
        `[bvnk webhook] pay-in ${event.paymentId} already settled transfer ${alreadyApplied.id}`
      );
      return;
    }
  }
  const matches = await getDb(env)
    .prepare(
      `SELECT id, provider_data
       FROM payment_transfers
       WHERE organization_id = ?
         AND project_id IS NOT DISTINCT FROM ?
         AND counterparty_id = ?
         AND provider = 'bvnk'
         AND type = 'onramp'
         AND status = ANY(?)
         AND provider_data->'bvnk'->>'fundingWalletId' = ?
         AND fiat_amount IS NOT NULL
         AND fiat_amount::numeric = ?::numeric
       ORDER BY id
       LIMIT 2`
    )
    .bind(
      counterparty.organization_id,
      counterparty.project_id,
      counterparty.id,
      SETTLEABLE_RAMP_TRANSFER_STATUSES,
      event.walletId,
      paymentAmount
    )
    .all<{ id: string; provider_data: { bvnk?: Record<string, unknown> } }>();
  // BVNK pay-in events do not carry the SDP quote id. Only a unique active
  // wallet+amount match is safe; choosing the newest row can settle the wrong quote.
  const match = matches.results[0];
  if (matches.results.length !== 1 || match === undefined) {
    getLogger().warn(
      `[bvnk webhook] refusing ambiguous pay-in settlement customer=${event.customerReference} wallet=${event.walletId} matches=${matches.results.length}`
    );
    return;
  }
  await payments.updateTransferStatusGuarded({
    transferId: match.id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    fromStatuses: SETTLEABLE_RAMP_TRANSFER_STATUSES,
    toStatus: "completed",
    amount: paymentAmount,
    fiatAmount: paymentAmount,
    updatedAt: new Date().toISOString(),
    // provider_data merges shallowly, so the bvnk object is rewritten whole.
    ...(event.paymentId
      ? {
          providerData: {
            bvnk: { ...match.provider_data.bvnk, appliedPayinId: event.paymentId },
          },
        }
      : {}),
  });
}

async function provisionPendingBvnkOnramps(
  env: Env,
  repo: CounterpartiesRepository,
  environment: SdpEnvironment,
  counterparty: CounterpartyRow,
  customer: BvnkCustomerResolution
): Promise<void> {
  const ctx = webhookRampContext(env, environment);
  if (!isBvnkCustomerVerified(customer.status)) {
    return;
  }
  const pendingKeys = pendingBvnkOnrampPaymentRuleKeys(counterparty.provider_data);
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
        ctx,
        repo,
        reloadedCounterparty,
        reloadedCounterparty.project_id,
        customer,
        entry.request
      );
    } catch (error) {
      await updateBvnkOnrampPaymentRuleState(repo, reloadedCounterparty, key, {
        provisioningError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function claimBvnkCustomerLinkReservation(
  env: Env,
  repo: CounterpartiesRepository,
  event: Extract<BvnkWebhookEvent, { kind: "bvnk:platform:customer:update" }>
): Promise<BvnkCustomerWebhookResolution> {
  const counterpartyId = parseBvnkCustomerExternalReference(event.externalReference);
  const counterparty =
    counterpartyId === null ? null : await repo.findActiveCounterpartyById(counterpartyId);
  if (counterparty === null) {
    throw internalError(
      `BVNK webhook customer ${event.customerReference} was not found or is not active`
    );
  }
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const link = await accounts.getProviderAccount({
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    counterpartyId: counterparty.id,
    provider: "bvnk",
  });
  if (link === null) {
    throw internalError(`BVNK webhook counterparty ${counterpartyId} has no customer-link row`);
  }
  if (link.provider_customer_reference === event.externalReference) {
    const assigned = await accounts.assignCustomerLinkReference({
      organizationId: counterparty.organization_id,
      projectId: counterparty.project_id,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      id: link.id,
      fromProviderCustomerReference: event.externalReference,
      providerCustomerReference: event.customerReference,
      metadata: { status: event.customerStatus },
    });
    if (assigned === null) {
      const current = await accounts.getProviderAccount({
        organizationId: counterparty.organization_id,
        projectId: counterparty.project_id,
        counterpartyId: counterparty.id,
        provider: "bvnk",
      });
      if (current === null || current.provider_customer_reference !== event.customerReference) {
        throw internalError("BVNK customer-link reference assignment lost its reservation CAS.");
      }
    }
  } else if (link.provider_customer_reference !== event.customerReference) {
    throw internalError(
      `BVNK webhook customer ${event.customerReference} does not match the customer link for ${counterpartyId}`
    );
  }
  return {
    counterparty,
    providerAccountId: link.id,
    customerReference: event.customerReference,
  };
}

/**
 * Resolves the counterparty and its BVNK customer-link row for a customer
 * event, either by the native reference or by claiming the reservation on a
 * platform:customer:update.
 */
async function resolveBvnkCustomerWebhookCounterparty(
  env: Env,
  repo: CounterpartiesRepository,
  event: BvnkCustomerWebhookEvent
): Promise<BvnkCustomerWebhookResolution> {
  const byNativeReference = await repo.findActiveCounterpartyByProviderCustomerReference({
    provider: "bvnk",
    providerCustomerReference: event.customerReference,
  });
  if (byNativeReference !== null) {
    const link = await createPostgresCounterpartyProviderAccountsRepository(
      getDb(env)
    ).getProviderAccount({
      organizationId: byNativeReference.organization_id,
      projectId: byNativeReference.project_id,
      counterpartyId: byNativeReference.id,
      provider: "bvnk",
    });
    if (link === null) {
      throw internalError(
        `BVNK webhook customer ${event.customerReference} has no customer-link row`
      );
    }
    return {
      counterparty: byNativeReference,
      providerAccountId: link.id,
      customerReference: link.provider_customer_reference,
    };
  }
  if (event.kind !== "bvnk:platform:customer:update") {
    throw internalError(
      `BVNK webhook customer ${event.customerReference} was not found or is not active`
    );
  }
  return claimBvnkCustomerLinkReservation(env, repo, event);
}

async function handleProviderOnrampCounterpartyRequirementWebhook(
  env: Env,
  environment: SdpEnvironment,
  event: BvnkCustomerWebhookEvent | Extract<BvnkWebhookEvent, { kind: "bvnk:wallet:onramp" }>
): Promise<void> {
  const repo = createSystemCounterpartiesRepository(env);

  switch (event.kind) {
    case "bvnk:customers:status-change":
    case "bvnk:platform:customer:status-change":
    case "bvnk:platform:customer:update": {
      const { counterparty, providerAccountId, customerReference } =
        await resolveBvnkCustomerWebhookCounterparty(env, repo, event);
      const { customer } = await refreshBvnkCustomerAccount(
        env,
        webhookRampContext(env, environment),
        { counterparty, projectId: counterparty.project_id, providerAccountId, customerReference }
      );
      await provisionPendingBvnkOnramps(env, repo, environment, counterparty, customer);
      return;
    }
  }

  const counterparty = await repo.findActiveCounterpartyById(event.wallet.counterpartyId);
  if (!counterparty) {
    throw internalError(
      `BVNK webhook counterparty ${event.wallet.counterpartyId} was not found or is not active`
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
    await updateBvnkOnrampPaymentRuleState(repo, counterparty, event.wallet.onrampKey, state);
  }
  if (isBvnkWalletActive(event.walletStatus)) {
    const customer = await readBvnkCustomerLink(env, counterparty);
    if (customer === null) {
      return;
    }
    await provisionPendingBvnkOnramps(env, repo, environment, counterparty, customer);
  }
}

async function handleProviderOfframpCounterpartyRequirementWebhook(
  env: Env,
  event: Extract<BvnkWebhookEvent, { kind: "bvnk:wallet:offramp" }>
): Promise<void> {
  const walletStatus = event.walletStatus;
  if (walletStatus === undefined) {
    getLogger().info("[bvnk webhook] merchant off-ramp wallet event is missing status");
    return;
  }

  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyById(event.wallet.counterpartyId);
  if (!counterparty) {
    throw internalError(
      `BVNK webhook counterparty ${event.wallet.counterpartyId} was not found or is not active`
    );
  }
  // TODO(PRO-1824): Move BVNK merchant-wallet state to counterparty_provider_accounts.
  await repo.mutateProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    mutate: (providerData) =>
      withBvnkOfframpWalletStatus(providerData, event.wallet.fiatCurrency, walletStatus),
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
  env: Env,
  event: BvnkChannelTransactionEvent
): Promise<void> {
  if (!event.transferId) {
    getLogger().info(`[bvnk webhook] "${event.kind}" has no SDP off-ramp transfer reference`);
    return;
  }

  const status =
    event.kind === "bvnk:payment:channel:transaction-detected" ? "settling" : "completed";
  const fiatAmount = status === "completed" ? event.walletAmount : undefined;
  await getDb(env)
    .prepare(
      `UPDATE payment_transfers
       SET status = ?,
           fiat_amount = CASE WHEN ?::boolean THEN ? ELSE fiat_amount END,
           updated_at = ?
       WHERE id = ?
         AND provider = 'bvnk'
         AND type = 'offramp'
         AND status <> ALL(?)`
    )
    .bind(
      status,
      fiatAmount !== undefined,
      fiatAmount === undefined ? null : fiatAmount,
      new Date().toISOString(),
      event.transferId,
      TERMINAL_RAMP_TRANSFER_STATUSES
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
    const envelope = BVNK_WEBHOOK_ENVELOPE.safeParse(payload);
    if (!envelope.success) {
      throw badRequest("BVNK webhook is missing an event", { provider: this.provider });
    }
    const event = envelope.data.event;
    if (!isHandledBvnkEvent(event)) {
      return { kind: "ignore", event };
    }
    const data = BVNK_WEBHOOK_DATA.safeParse(envelope.data.data);
    if (!data.success) {
      throw badRequest(`BVNK webhook "${event}" is missing a data object`, {
        provider: this.provider,
      });
    }

    const parseData = <S extends z.ZodType>(schema: S): z.infer<S> =>
      parseBvnkWebhookData(event, schema, data.data, this.provider);

    switch (event) {
      case "bvnk:customers:status-change": {
        const parsed = parseData(bvnkCustomersStatusChangeSchema);
        return { kind: event, customerReference: parsed.customerId, customerStatus: parsed.status };
      }
      case "bvnk:platform:customer:status-change": {
        const parsed = parseData(bvnkPlatformCustomerStatusChangeSchema);
        return { kind: event, customerReference: parsed.reference, customerStatus: parsed.status };
      }
      case "bvnk:platform:customer:update": {
        const parsed = parseData(bvnkPlatformCustomerUpdateSchema);
        return {
          kind: event,
          customerReference: parsed.reference,
          externalReference: parsed.externalReference,
          customerStatus: parsed.status,
        };
      }
      case "ledger:v2:wallet:status-change":
      case "bvnk:ledger:wallet:create": {
        if (event === "ledger:v2:wallet:status-change") {
          const parsed = parseData(bvnkLedgerWalletStatusChangeSchema);
          return parseBvnkWalletWebhookData(
            event,
            parsed.name,
            parsed.status,
            bvnkFiatWalletBankAccount(parsed.paymentInstruments)
          );
        }
        const parsed = parseData(bvnkLedgerWalletCreateSchema);
        return parseBvnkWalletWebhookData(
          event,
          parsed.walletName,
          parsed.status,
          bvnkLedgerBankAccount(parsed.ledgers)
        );
      }
      case "bvnk:payment:payin:status-change": {
        const parsed = parseData(bvnkPayinStatusChangeSchema);
        return {
          kind: event,
          customerReference: parsed.customerReference,
          walletId: parsed.beneficiary?.walletId,
          status: parsed.status,
          amount: parsed.amount?.value,
          paymentId: parsed.uuid,
        };
      }
      case "bvnk:payment:channel:transaction-detected":
      case "bvnk:payment:channel:transaction-confirmed": {
        const parsed = parseData(bvnkChannelTransactionSchema);
        return {
          kind: event,
          transferId:
            parsed.reference === undefined ? undefined : readBvnkOfframpReference(parsed.reference),
          channelId: parsed.channelId,
          transactionId: parsed.uuid,
          transactionHash: parsed.hash,
          status: parsed.status,
          paidCurrency: parsed.paidCurrency,
          paidAmount: parsed.paidAmount,
          displayCurrency: parsed.displayCurrency,
          displayAmount: parsed.displayAmount,
          walletCurrency: parsed.walletCurrency,
          walletAmount: parsed.walletAmount,
          feeCurrency: parsed.feeCurrency,
          feeAmount: parsed.feeAmount,
        };
      }
    }
  }

  async process(env: Env, environment: SdpEnvironment, event: BvnkWebhookEvent): Promise<void> {
    switch (event.kind) {
      case "ignore":
        getLogger().info(`[bvnk webhook] ignoring event "${event.event}"`);
        return;
      case "bvnk:payment:payin:status-change":
        return handleProviderOnrampSettlementWebhook(env, event);
      case "bvnk:payment:channel:transaction-detected":
      case "bvnk:payment:channel:transaction-confirmed":
        return handleProviderOfframpSettlementWebhook(env, event);
      case "bvnk:customers:status-change":
      case "bvnk:platform:customer:status-change":
      case "bvnk:platform:customer:update":
        return handleProviderOnrampCounterpartyRequirementWebhook(env, environment, event);
      case "bvnk:wallet:onramp":
        return handleProviderOnrampCounterpartyRequirementWebhook(env, environment, event);
      case "bvnk:wallet:offramp":
        return handleProviderOfframpCounterpartyRequirementWebhook(env, event);
    }
  }
}
