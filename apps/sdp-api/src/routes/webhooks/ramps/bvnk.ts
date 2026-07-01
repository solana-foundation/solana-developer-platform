import type { RampFiatCurrency, SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { createCounterpartiesRepository } from "@/db/repositories";
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";
import { internalError } from "@/lib/errors";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  type BvnkCustomerResolution,
  type BvnkWebhookEvent,
  isBvnkCustomerVerified,
  isBvnkWalletActive,
  parseBvnkOfframpWalletName,
  parseBvnkOnrampWalletName,
  readBvnkCustomer,
  readBvnkData,
  readBvnkOfframpWallets,
  readBvnkOnrampPaymentRuleState,
  readBvnkWallets,
} from "@/lib/ramps/providers/bvnk";
import type { RampRuntimeContext } from "@/lib/ramps/types";
import { ensureBvnkPaymentRule } from "@/routes/payments/handlers/ramps/bvnk";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

function webhookRampContext(c: AppContext, environment: SdpEnvironment): RampRuntimeContext {
  return { env: c.env as unknown as Record<string, string | undefined>, mode: environment };
}

async function updateBvnkOnrampPaymentRuleState(
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  onrampPaymentRuleKey: string,
  paymentRule: Record<string, unknown>
): Promise<void> {
  const bvnk = readBvnkData(counterparty.provider_data);
  const wallets = readBvnkWallets(counterparty.provider_data);
  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    providerData: {
      ...counterparty.provider_data,
      bvnk: {
        ...bvnk,
        wallets: {
          ...wallets,
          [onrampPaymentRuleKey]: {
            ...wallets[onrampPaymentRuleKey],
            ...paymentRule,
          },
        },
      },
    },
  });
}

async function updateBvnkOfframpWalletStatus(
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  fiatCurrency: RampFiatCurrency,
  status: string
): Promise<void> {
  const bvnk = readBvnkData(counterparty.provider_data);
  const offramp =
    bvnk.offramp && typeof bvnk.offramp === "object"
      ? (bvnk.offramp as Record<string, unknown>)
      : {};
  const wallets = readBvnkOfframpWallets(counterparty.provider_data);
  await repo.updateCounterparty({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    providerData: {
      ...counterparty.provider_data,
      bvnk: {
        ...bvnk,
        offramp: {
          ...offramp,
          wallets: {
            ...wallets,
            [fiatCurrency]: { ...wallets[fiatCurrency], status },
          },
        },
      },
    },
  });
}

async function resolveBvnkOfframpWalletCounterparty(
  repo: CounterpartiesRepository,
  walletName: string
): Promise<{ counterparty: CounterpartyRow; fiatCurrency: RampFiatCurrency }> {
  const wallet = parseBvnkOfframpWalletName(walletName);
  const counterparty = await repo.findActiveCounterpartyById(wallet.counterpartyId);
  if (!counterparty) {
    throw internalError(
      `BVNK webhook counterparty ${wallet.counterpartyId} was not found or is not active`
    );
  }

  return { counterparty, fiatCurrency: wallet.fiatCurrency };
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

async function applyBvnkOnrampFundingWalletRequirementWebhook(
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  onrampPaymentRuleKey: string,
  event: Extract<
    BvnkWebhookEvent,
    { kind: "ledger:v2:wallet:status-change" | "bvnk:ledger:wallet:create" }
  >
): Promise<void> {
  const bankAccount = event.bankAccount;
  const hasBankAccountNumber =
    bankAccount &&
    typeof bankAccount.accountNumber === "string" &&
    bankAccount.accountNumber.length > 0;
  if (!event.walletStatus && !hasBankAccountNumber) {
    return;
  }

  const wallet: Record<string, unknown> = {};
  if (event.walletStatus) wallet.walletStatus = event.walletStatus;
  if (hasBankAccountNumber) wallet.bankAccount = bankAccount;
  await updateBvnkOnrampPaymentRuleState(repo, counterparty, onrampPaymentRuleKey, wallet);
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
  const pendingKeys = Object.entries(readBvnkWallets(currentCounterparty.provider_data))
    .filter(([, entry]) => entry.request && !entry.ruleId)
    .map(([key]) => key);
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
  await applyBvnkOnrampFundingWalletRequirementWebhook(repo, counterparty, wallet.onrampKey, event);
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
  const resolution = await resolveBvnkOfframpWalletCounterparty(repo, event.walletName);
  const { counterparty, fiatCurrency } = resolution;
  await updateBvnkOfframpWalletStatus(repo, counterparty, fiatCurrency, event.walletStatus);
}

type BvnkChannelTransactionEvent = Extract<
  BvnkWebhookEvent,
  {
    kind:
      | "bvnk:payment:channel:transaction-detected"
      | "bvnk:payment:channel:transaction-confirmed";
  }
>;

function bvnkChannelTransactionTransferStatus(
  event: BvnkChannelTransactionEvent
): "settling" | "completed" {
  switch (event.kind) {
    case "bvnk:payment:channel:transaction-detected":
      return "settling";
    case "bvnk:payment:channel:transaction-confirmed":
      return "completed";
  }
}

function bvnkChannelTransactionFiatAmount(event: BvnkChannelTransactionEvent): string | undefined {
  return event.walletAmount ?? event.displayAmount;
}

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

  const status = bvnkChannelTransactionTransferStatus(event);
  let fiatAmount: string | undefined;
  if (status === "completed") {
    fiatAmount = bvnkChannelTransactionFiatAmount(event);
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

export async function handleBvnkRampWebhook(
  c: AppContext,
  environment: SdpEnvironment,
  payload: unknown
): Promise<void> {
  const event = RAMP_PROVIDER_CLIENTS.bvnk.parseBvnkWebhookEvent(payload);

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
