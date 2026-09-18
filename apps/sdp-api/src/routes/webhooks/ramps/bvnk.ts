import { SdpPaymentsError } from "@sdp/payments";
import { compareDecimalAmounts } from "@sdp/payments/decimal";
import {
  BVNK_FUNDING_WALLET_FIAT,
  type BVNKWallet,
  type BvnkOnrampTransferData,
  type BvnkUnrecognisedWalletName,
  isBvnkCustomerVerified,
  isBvnkWalletActive,
  parseBvnkCustomerExternalReference,
  parseBvnkTransferIdFromRemittance,
  parseBvnkWalletName,
  readBvnkOfframpReference,
  readBvnkOnrampTransferData,
  withBvnkOfframpWalletStatus,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  bvnkPayoutObservationFromSource,
  readStoredBvnkSettlement,
} from "@sdp/payments/ramps/providers/bvnk/settlement";
import type { RampRuntimeContext, RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import {
  BVNK_FUNDING_WALLET_STATUS,
  NON_TERMINAL_RAMP_TRANSFER_STATUSES,
  type SdpEnvironment,
} from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import { buildInClause } from "@/db/postgres-utils";
import {
  createPostgresBvnkOnrampTransfersRepository,
  createPostgresCounterpartyProviderAccountsRepository,
  createSystemCounterpartiesRepository,
} from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { AppError, badRequest, internalError, providerNotConfigured } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import {
  type BvnkProvisioningAudit,
  ensureBvnkFundingWallet,
  refreshBvnkCustomerAccount,
} from "@/routes/payments/handlers/ramps/bvnk";
import { applyTerminalBvnkPayoutObservation } from "@/routes/payments/handlers/ramps/bvnk-settlement";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import {
  type BvnkWalletWebhookData,
  type BvnkWebhook,
  bvnkWebhookEnvelopeSchema,
  bvnkWebhookEventSchema,
  bvnkWebhookSchema,
  isBvnkCryptoPayoutStatus,
  isBvnkPayinStatus,
} from "./bvnk.schema";
import { TerminalRampWebhookError, type WebhookProcessor } from "./processor";

type BvnkParsedWebhook = BvnkWebhook | { event: "ignore"; reason: string };

type BvnkV1PayinData = Extract<BvnkWebhook, { event: "bvnk:payment:payin:status-change" }>["data"];

type BvnkCryptoPayoutData = Extract<
  BvnkWebhook,
  { event: "bvnk:payment:crypto:status-change" }
>["data"];

/** The migration-0113 unique expression index over `provider_data->'bvnk'->'payin'->>'id'`. */
const BVNK_ONRAMP_PAYIN_UNIQUE_CONSTRAINT = "payment_transfers_bvnk_onramp_payin_id_unique";

function isBvnkOnrampPayinUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505" &&
    "constraint" in error &&
    (error as { constraint?: unknown }).constraint === BVNK_ONRAMP_PAYIN_UNIQUE_CONSTRAINT
  );
}

function webhookRampContext(env: Env, environment: SdpEnvironment): RampRuntimeContext {
  return { env: env as unknown as Record<string, string | undefined>, mode: environment };
}

/**
 * Compares the immutable pay-in ownership facts an event carries against the
 * facts already persisted on a transfer; amounts compare numerically.
 *
 * @param data - Parsed v1 pay-in status-change event data.
 * @param payin - The persisted pay-in ownership facts, when the transfer carries them.
 * @returns True when every immutable fact is identical.
 */
function payinFactsMatch(data: BvnkV1PayinData, payin: BvnkOnrampTransferData["payin"]): boolean {
  if (payin === undefined) {
    return false;
  }
  return (
    payin.walletId === data.beneficiary.walletId &&
    payin.customerId === data.customerReference &&
    compareDecimalAmounts(payin.receivedAmount, String(data.amount.value)) === 0 &&
    payin.receivedCurrency === data.amount.currencyCode
  );
}

/**
 * Applies the pay-in replay rule: identical immutable facts are acknowledged
 * without a write, divergent facts are terminal because the money cannot be
 * re-attributed.
 *
 * @param transfer - The transfer already owning the pay-in id.
 * @param data - Parsed v1 pay-in status-change event data.
 */
async function resolvePayinReplay(
  transfer: PaymentTransferRow,
  data: BvnkV1PayinData
): Promise<void> {
  const bvnkData = readBvnkOnrampTransferData(transfer.provider_data);
  if (payinFactsMatch(data, bvnkData.payin)) {
    getLogger().info(
      { transfer_id: transfer.id, payin_id: data.transactionReference },
      "[bvnk webhook] pay-in replay"
    );
    return;
  }
  getLogger().error(
    {
      transfer_id: transfer.id,
      payin_id: data.transactionReference,
      wallet_id: data.beneficiary.walletId,
      customer_reference: data.customerReference,
      amount: String(data.amount.value),
      currency: data.amount.currencyCode,
    },
    "[bvnk webhook] conflicting pay-in observation"
  );
  throw new TerminalRampWebhookError("stray pay-in: conflicting pay-in observation");
}

/**
 * Re-resolves the owner of a pay-in id after a lost apply and applies the
 * replay rule; an id with no owner in this environment is terminal.
 *
 * @param env - Process environment used for repository access.
 * @param environment - The project environment the webhook was delivered for.
 * @param payinId - The pay-in id whose owner must be re-resolved.
 * @param data - Parsed v1 pay-in status-change event data.
 */
async function resolveRacedPayinOwner(
  env: Env,
  environment: SdpEnvironment,
  payinId: string,
  data: BvnkV1PayinData
): Promise<void> {
  const racedOwner = await createPostgresBvnkOnrampTransfersRepository(getDb(env)).getByPayinId({
    payinId,
    environment,
  });
  if (racedOwner === null) {
    throw new TerminalRampWebhookError("stray pay-in: conflicting pay-in has no owner");
  }
  return resolvePayinReplay(racedOwner, data);
}

/**
 * Applies a COMPLETED v1 fiat pay-in status-change event: resolves the pay-in
 * owner by its transaction reference, else attributes it by the transfer id
 * parsed from the joined remittance fields, verifies the transfer and its
 * funding-wallet binding, and settles the transfer via the single
 * first-write-wins repository update. Ambiguity, unknown references, binding
 * mismatches, and conflicting observations are terminal; identical replays
 * are acknowledged whatever the transfer status.
 *
 * @param env - Process environment used for repository access.
 * @param environment - The project environment the webhook was delivered for.
 * @param data - Parsed v1 pay-in status-change event data.
 */
async function handleBvnkPayinStatusChange(
  env: Env,
  environment: SdpEnvironment,
  data: BvnkV1PayinData
): Promise<void> {
  if (!isBvnkPayinStatus(data.status)) {
    getLogger().info(
      { payin_id: data.transactionReference, status: data.status },
      "[bvnk webhook] pay-in status ignored"
    );
    return;
  }
  const transfers = createPostgresBvnkOnrampTransfersRepository(getDb(env));
  const transferOwner = await transfers.getByPayinId({
    payinId: data.transactionReference,
    environment,
  });
  if (transferOwner !== null) {
    return resolvePayinReplay(transferOwner, data);
  }
  let parsedTransferId: string | null;
  try {
    parsedTransferId = parseBvnkTransferIdFromRemittance(
      data.paymentReference,
      data.metadata?.additionalRemittanceInformation
    );
  } catch (error) {
    if (error instanceof SdpPaymentsError && error.code === "INTERNAL_ERROR") {
      throw new TerminalRampWebhookError("stray pay-in: ambiguous remittance");
    }
    throw error;
  }
  if (parsedTransferId === null) {
    throw new TerminalRampWebhookError("stray pay-in: no transfer reference");
  }
  const transfer = await transfers.getById({ transferId: parsedTransferId, environment });
  if (transfer === null) {
    throw new TerminalRampWebhookError("stray pay-in: unknown transfer or environment mismatch");
  }
  if (transfer.status !== "awaiting_payment") {
    return resolveRacedPayinOwner(env, environment, data.transactionReference, data);
  }
  if (transfer.counterparty_id === null) {
    throw new TerminalRampWebhookError("stray pay-in: transfer has no counterparty");
  }
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const fundingRow = await accounts.findActiveFundingWalletByReference({
    provider: "bvnk",
    externalAccountReference: data.beneficiary.walletId,
    environment,
  });
  if (fundingRow === null) {
    throw new TerminalRampWebhookError("stray pay-in: unknown funding wallet");
  }
  const fundingWalletReference = fundingRow.external_account_reference;
  if (
    fundingWalletReference === null ||
    fundingWalletReference !== data.beneficiary.walletId ||
    fundingRow.counterparty_id !== transfer.counterparty_id ||
    fundingRow.provider_customer_reference !== data.customerReference
  ) {
    throw new TerminalRampWebhookError("stray pay-in: funding wallet binding mismatch");
  }
  const receivedAmount = String(data.amount.value);
  if (compareDecimalAmounts(receivedAmount, "0") <= 0) {
    throw new TerminalRampWebhookError("stray pay-in: received amount is not a positive decimal");
  }
  let applied: PaymentTransferRow | null;
  try {
    applied = await transfers.applyPayin({
      transferId: transfer.id,
      fundingWalletReference,
      payin: {
        id: data.transactionReference,
        receivedAmount,
        receivedCurrency: data.amount.currencyCode,
        walletId: data.beneficiary.walletId,
        customerId: data.customerReference,
      },
    });
  } catch (error) {
    if (isBvnkOnrampPayinUniqueViolation(error)) {
      return resolveRacedPayinOwner(env, environment, data.transactionReference, data);
    }
    throw error;
  }
  if (applied === null) {
    return resolveRacedPayinOwner(env, environment, data.transactionReference, data);
  }
  getLogger().info(
    {
      counterparty_id: transfer.counterparty_id,
      transfer_id: transfer.id,
      payin_id: data.transactionReference,
      received_amount: receivedAmount,
      received_currency: data.amount.currencyCode,
    },
    "[bvnk webhook] pay-in settling transfer"
  );
}

/**
 * Applies a BVNK crypto payout status-change event (the reference IS the
 * transfer id): PROCESSING verifies the recorded settlement and writes
 * nothing; completed or failed statuses go through the shared terminal
 * operation; unknown statuses are ignored.
 *
 * @param env - Process environment used for repository access.
 * @param environment - The project environment the webhook was delivered for.
 * @param data - Parsed crypto payout status-change event data.
 */
async function handleBvnkCryptoPayoutStatusChange(
  env: Env,
  environment: SdpEnvironment,
  data: BvnkCryptoPayoutData
): Promise<void> {
  if (!isBvnkCryptoPayoutStatus(data.status)) {
    getLogger().info(
      { payout_id: data.uuid, status: data.status },
      "[bvnk webhook] crypto payout status ignored"
    );
    return;
  }
  if (data.reference === null) {
    throw new TerminalRampWebhookError("stray payout: no transfer reference");
  }
  const transfers = createPostgresBvnkOnrampTransfersRepository(getDb(env));
  const transfer = await transfers.getById({ transferId: data.reference, environment });
  if (transfer === null) {
    throw new TerminalRampWebhookError("stray payout: unknown transfer or environment mismatch");
  }
  if (data.status === "PROCESSING") {
    const stored = readStoredBvnkSettlement(transfer.provider_data);
    if (stored.outcome === "malformed") {
      throw internalError("BVNK on-ramp transfer has a malformed stored settlement.");
    }
    if (stored.outcome === "absent") {
      throw internalError(
        "BVNK payout PROCESSING webhook arrived before the settlement was recorded; the inbox replay will retry"
      );
    }
    getLogger().info(
      { payout_id: data.uuid, status: data.status },
      "[bvnk webhook] crypto payout processing"
    );
    return;
  }
  const parsed = bvnkPayoutObservationFromSource(data);
  if (!parsed.ok) {
    throw internalError(
      "BVNK payout observation lacks the transaction hash or destination address; the inbox replay will retry"
    );
  }
  await applyTerminalBvnkPayoutObservation({
    repo: transfers,
    environment,
    transfer,
    observation: parsed.observation,
    failError: data.status,
    terminalError: (message) => new TerminalRampWebhookError(message),
  });
}

/**
 * Applies the shared tail of a BVNK customer-state webhook: resolves the
 * customer-link row and records a verified status patch or a provider
 * refresh; the counterparty was resolved environment-scoped, so every
 * mutation stays inside that tenant scope.
 *
 * @param env - Process environment used for repository access.
 * @param environment - Sandbox or production ramp environment.
 * @param counterparty - Counterparty the event targets.
 * @param eventName - Parsed BVNK event name, used in the missing-link log.
 * @param options - Whether to refresh the provider account, or patch the verified status the event carries.
 */
async function applyBvnkCustomerStateWebhook(
  env: Env,
  environment: SdpEnvironment,
  counterparty: CounterpartyRow,
  eventName: string,
  options: { refresh: true } | { refresh: false; status: string }
): Promise<void> {
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const row = await accounts.getProviderAccount({
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    counterpartyId: counterparty.id,
    provider: "bvnk",
  });
  if (row === null) {
    getLogger().info(`[bvnk webhook] "${eventName}" for ${counterparty.id} has no customer link`);
    return;
  }
  if (options.refresh) {
    await refreshBvnkCustomerAccount(env, webhookRampContext(env, environment), {
      counterparty,
      projectId: counterparty.project_id,
      providerAccountId: row.id,
      customerReference: row.provider_customer_reference,
    });
  } else {
    const updated = await accounts.patchAccountMetadata({
      organizationId: counterparty.organization_id,
      projectId: counterparty.project_id,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      id: row.id,
      set: { status: options.status },
      unset: [],
    });
    if (!updated) {
      throw internalError("BVNK customer status update escaped its tenant scope.");
    }
    await ensureBvnkFundingWallet(env, webhookRampContext(env, environment), {
      counterparty,
      projectId: counterparty.project_id,
      customerLink: row,
      fiatCurrency: BVNK_FUNDING_WALLET_FIAT,
      audit: webhookProvisioningAudit(env, counterparty),
    });
  }
}

/**
 * Applies the v2 platform customer status-change event: resolves the
 * counterparty by the provider customer reference the event carries within
 * the webhook's environment, then applies the verified status patch or
 * refreshes the provider account for any other status. A reference that does
 * not resolve in this environment is terminal.
 *
 * @param env - Process environment used for repository access.
 * @param environment - Sandbox or production ramp environment.
 * @param event - Parsed v2 platform customer status-change event.
 */
async function handleBvnkCustomerStatusChange(
  env: Env,
  environment: SdpEnvironment,
  event: Extract<BvnkWebhook, { event: "bvnk:platform:customer:status-change" }>
): Promise<void> {
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyByProviderCustomerReference({
    provider: "bvnk",
    providerCustomerReference: event.data.reference,
    environment,
  });
  if (!counterparty) {
    throw new TerminalRampWebhookError(
      `BVNK webhook customer ${event.data.reference} was not found or is not active in this environment`
    );
  }
  if (isBvnkCustomerVerified(event.data.status)) {
    await applyBvnkCustomerStateWebhook(env, environment, counterparty, event.event, {
      refresh: false,
      status: event.data.status,
    });
    return;
  }
  await applyBvnkCustomerStateWebhook(env, environment, counterparty, event.event, {
    refresh: true,
  });
}

async function handleBvnkPlatformCustomerUpdate(
  env: Env,
  environment: SdpEnvironment,
  event: Extract<BvnkWebhook, { event: "bvnk:platform:customer:update" }>
): Promise<void> {
  const counterpartyId = parseBvnkCustomerExternalReference(event.data.reference);
  if (counterpartyId === null) {
    throw new TerminalRampWebhookError(
      `BVNK webhook customer ${event.data.reference} was not found or is not active in this environment`
    );
  }
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyById({
    counterpartyId,
    environment,
  });
  if (!counterparty) {
    throw new TerminalRampWebhookError(
      `BVNK webhook customer ${event.data.reference} was not found or is not active in this environment`
    );
  }
  await applyBvnkCustomerStateWebhook(env, environment, counterparty, event.event, {
    refresh: true,
  });
}

/**
 * Records a provider-confirmed BVNK agreement-session signature for the
 * customer link that owns the session in the webhook's environment.
 *
 * @param env - Process environment used for repository access.
 * @param environment - Sandbox or production ramp environment.
 * @param event - Parsed BVNK agreement-session status-change event.
 */
async function handleBvnkPlatformCustomerAgreementSessionStatusChange(
  env: Env,
  environment: SdpEnvironment,
  event: Extract<BvnkWebhook, { event: "bvnk:platform:customer:agreement-session-status-change" }>
): Promise<void> {
  const sessionReference = event.data.reference;
  if (event.data.status !== "SIGNED") {
    getLogger().info(
      { session_reference: sessionReference, status: event.data.status },
      "[bvnk webhook] ignored agreement session status"
    );
    return;
  }
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const row = await accounts.findCustomerLinkBySessionReference({
    provider: "bvnk",
    sessionReference,
    environment,
  });
  if (row === null) {
    throw new TerminalRampWebhookError(
      `BVNK agreement session ${sessionReference} has no customer link in this environment`
    );
  }
  const signedAt = new Date(event.timestamp).toISOString();
  const updated = await accounts.markCustomerLinkSessionTimestamp({
    organizationId: row.organization_id,
    projectId: row.project_id,
    counterpartyId: row.counterparty_id,
    provider: "bvnk",
    id: row.id,
    sessionReference,
    field: "signedAt",
    timestamp: signedAt,
  });
  if (updated === null) {
    getLogger().info(
      { counterparty_id: row.counterparty_id, session_reference: sessionReference },
      "[bvnk webhook] agreement session already signed"
    );
    return;
  }
  getLogger().info(
    {
      counterparty_id: row.counterparty_id,
      session_reference: sessionReference,
      signed_at: signedAt,
    },
    "[bvnk webhook] agreement session signed"
  );
}

/**
 * Builds the system provisioning audit for webhook-driven BVNK provisioning;
 * there is no request actor, so the system intent/outcome pair still records
 * what was created and why.
 *
 * @param env - Process environment used for audit-ledger access.
 * @param counterparty - Counterparty the provisioning step targets.
 * @returns The system audit adapter for the counterparty.
 */
function webhookProvisioningAudit(env: Env, counterparty: CounterpartyRow): BvnkProvisioningAudit {
  return {
    async begin({ action, metadata }) {
      return new AuditService(getDb(env), createKVStoreSet(env).cache).beginCriticalSystem({
        organizationId: counterparty.organization_id,
        action: "update",
        resourceType: "counterparty",
        resourceId: counterparty.id,
        metadata: { action, provider: "bvnk", trigger: "bvnk_webhook", ...metadata },
      });
    },
    async complete(intent, metadata) {
      await new AuditService(getDb(env), createKVStoreSet(env).cache).completeCriticalSystem(
        intent,
        {
          metadata,
        }
      );
    },
    async fail(intent, error) {
      await new AuditService(getDb(env), createKVStoreSet(env).cache).completeCriticalSystem(
        intent,
        {
          status: "failure",
          metadata: {
            error: error instanceof Error ? error.message : String(error),
            providerOutcome: "unverified",
          },
        }
      );
    },
  };
}

async function handleBvnkOfframpWalletWebhook(
  env: Env,
  environment: SdpEnvironment,
  wallet: Extract<BVNKWallet, { kind: "merchant_offramp" }>,
  status: string
): Promise<void> {
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyById({
    counterpartyId: wallet.counterpartyId,
    environment,
  });
  if (!counterparty) {
    throw new TerminalRampWebhookError(
      `BVNK webhook counterparty ${wallet.counterpartyId} was not found or is not active`
    );
  }
  await repo.mutateProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    mutate: (providerData) =>
      withBvnkOfframpWalletStatus(providerData, wallet.fiatCurrency, status),
  });
}

/**
 * Applies a funding-wallet status-change event: verifies the wallet belongs
 * to the claimed funding row in the webhook's environment and carries the
 * FIAT instrument with the account number, then CAS-advances the row from
 * provisioning to provisioned. A non-ACTIVE status, a replay after
 * provisioning, or an ACTIVE event without a FIAT instrument is logged and
 * acknowledged without the CAS; a diverging wallet or customer is terminal;
 * an event before the reference is assigned fails loudly and replay heals it.
 *
 * @param env - Process environment used for repository access.
 * @param environment - The project environment the event was delivered for.
 * @param wallet - Parsed funding-wallet name carrying the customer-link row id.
 * @param data - Parsed status-change event data.
 */
async function handleBvnkFundingWalletStatusChange(
  env: Env,
  environment: SdpEnvironment,
  wallet: Extract<BVNKWallet, { kind: "funding_wallet" }>,
  data: Extract<BvnkWebhook, { event: "ledger:v2:wallet:status-change" }>["data"]
): Promise<void> {
  if (!isBvnkWalletActive(data.status)) {
    getLogger().info(
      { provider_account_id: wallet.providerAccountId, wallet_id: data.id, status: data.status },
      "[bvnk webhook] funding wallet status ignored"
    );
    return;
  }
  if (data.customer === undefined) {
    throw internalError("BVNK funding wallet event carries no customer");
  }
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const row = await accounts.findActiveFundingWalletByCustomerLinkId({
    provider: "bvnk",
    customerLinkId: wallet.providerAccountId,
    fiatCurrency: BVNK_FUNDING_WALLET_FIAT,
    environment,
  });
  if (row === null) {
    throw new TerminalRampWebhookError(
      `BVNK funding wallet event references no claimed funding row for customer link ${wallet.providerAccountId} in this environment`
    );
  }
  if (row.external_account_reference === null) {
    throw internalError("BVNK funding wallet reference is not assigned yet.");
  }
  if (row.external_account_reference !== data.id) {
    throw new TerminalRampWebhookError("BVNK funding wallet event targets a different wallet.");
  }
  if (row.provider_customer_reference !== data.customer.id) {
    throw new TerminalRampWebhookError("BVNK funding wallet belongs to another customer.");
  }
  if (data.bankAccount === undefined || data.bankAccount.accountNumber === undefined) {
    getLogger().info(
      { provider_account_id: row.id, wallet_id: data.id },
      "[bvnk webhook] funding wallet ACTIVE without a FIAT account number; not marking ready"
    );
    return;
  }
  const updated = await accounts.updateFundingWalletStatus({
    organizationId: row.organization_id,
    projectId: row.project_id,
    counterpartyId: row.counterparty_id,
    provider: "bvnk",
    id: row.id,
    fromStatus: BVNK_FUNDING_WALLET_STATUS.provisioning,
    toStatus: BVNK_FUNDING_WALLET_STATUS.provisioned,
  });
  if (updated === null) {
    getLogger().info(
      { provider_account_id: row.id, wallet_id: data.id },
      "[bvnk webhook] funding wallet already provisioned"
    );
    return;
  }
  getLogger().info(
    { counterparty_id: row.counterparty_id, provider_account_id: row.id, wallet_id: data.id },
    "[bvnk webhook] funding wallet provisioned"
  );
}

/**
 * Applies a wallet lifecycle event by its parsed name; any other name is
 * acknowledged as terminal: SDP no longer manages those wallets, so the
 * event is never retried.
 *
 * @param env - Process environment used for repository access.
 * @param environment - The project environment the event was delivered for.
 * @param wallet - Parsed wallet name, or the unrecognised name itself.
 * @param data - Parsed status-change event data.
 */
async function applyBvnkWalletEvent(
  env: Env,
  environment: SdpEnvironment,
  wallet: BVNKWallet | BvnkUnrecognisedWalletName,
  data: BvnkWalletWebhookData
): Promise<void> {
  switch (wallet.kind) {
    case "merchant_offramp":
      if (!data.status) {
        getLogger().info("[bvnk webhook] merchant off-ramp wallet event is missing status");
        return;
      }
      return handleBvnkOfframpWalletWebhook(env, environment, wallet, data.status);
    case "funding_wallet": {
      if (!("id" in data)) {
        getLogger().info(
          { provider_account_id: wallet.providerAccountId, status: data.status },
          "[bvnk webhook] funding wallet lifecycle event"
        );
        return;
      }
      return handleBvnkFundingWalletStatusChange(env, environment, wallet, data);
    }
    case "unrecognised":
      getLogger().warn(
        { wallet_name: wallet.name },
        "[bvnk webhook] acknowledging a wallet SDP no longer manages"
      );
      throw new TerminalRampWebhookError(
        `BVNK wallet event names a wallet SDP no longer manages: ${wallet.name}`
      );
  }
}

/**
 * Applies an off-ramp channel settlement transition scoped to the webhook's
 * project environment; a sandbox-signed event naming a production off-ramp
 * transfer is terminal.
 * @param env - Process environment used for database access.
 * @param environment - The project environment the event was delivered for.
 * @param transferId - SDP off-ramp transfer identifier.
 * @param status - Settlement status to apply.
 * @param walletAmount - Confirmed wallet amount, when BVNK has supplied one.
 */
async function settleBvnkOfframpChannel(
  env: Env,
  environment: SdpEnvironment,
  transferId: string,
  status: "settling" | "completed",
  walletAmount: string | null
): Promise<void> {
  const existing = await getDb(env)
    .prepare(
      `SELECT pt.id
       FROM payment_transfers pt
       JOIN projects prj ON prj.id = pt.project_id
       WHERE pt.id = ?
         AND pt.provider = 'bvnk'
         AND pt.type = 'offramp'
         AND prj.environment = ?`
    )
    .bind(transferId, environment)
    .first<{ id: string }>();
  if (existing === null) {
    throw new TerminalRampWebhookError(
      "stray off-ramp channel event: unknown transfer or environment mismatch"
    );
  }
  const placeholders = buildInClause(NON_TERMINAL_RAMP_TRANSFER_STATUSES.length);
  await getDb(env)
    .prepare(
      `UPDATE payment_transfers pt
       SET status = ?,
           fiat_amount = CASE WHEN ?::boolean THEN ? ELSE fiat_amount END,
           updated_at = ?
       WHERE pt.id = ?
         AND pt.provider = 'bvnk'
         AND pt.type = 'offramp'
         AND pt.status IN (${placeholders})
         AND EXISTS (
           SELECT 1 FROM projects prj WHERE prj.id = pt.project_id AND prj.environment = ?
         )`
    )
    .bind(
      status,
      walletAmount !== null,
      walletAmount,
      new Date().toISOString(),
      transferId,
      ...NON_TERMINAL_RAMP_TRANSFER_STATUSES,
      environment
    )
    .run();
}

function bvnkChannelTransferId(
  event: Extract<
    BvnkWebhook,
    {
      event:
        | "bvnk:payment:channel:transaction-detected"
        | "bvnk:payment:channel:transaction-confirmed";
    }
  >
): string | undefined {
  const transferId =
    event.data.reference === undefined ? undefined : readBvnkOfframpReference(event.data.reference);
  if (transferId === undefined) {
    getLogger().info(`[bvnk webhook] "${event.event}" has no SDP off-ramp transfer reference`);
  }
  return transferId;
}

async function handleBvnkPaymentChannelTransactionDetected(
  env: Env,
  environment: SdpEnvironment,
  event: Extract<BvnkWebhook, { event: "bvnk:payment:channel:transaction-detected" }>
): Promise<void> {
  const transferId = bvnkChannelTransferId(event);
  if (transferId === undefined) {
    return;
  }
  await settleBvnkOfframpChannel(env, environment, transferId, "settling", null);
}

async function handleBvnkPaymentChannelTransactionConfirmed(
  env: Env,
  environment: SdpEnvironment,
  event: Extract<BvnkWebhook, { event: "bvnk:payment:channel:transaction-confirmed" }>
): Promise<void> {
  const transferId = bvnkChannelTransferId(event);
  if (transferId === undefined) {
    return;
  }
  await settleBvnkOfframpChannel(
    env,
    environment,
    transferId,
    "completed",
    event.data.walletAmount
  );
}

export class BvnkWebhookProcessor implements WebhookProcessor<unknown, BvnkParsedWebhook> {
  readonly provider = "bvnk";

  /**
   * Verifies the HMAC signature of a BVNK webhook body.
   * @param context - Webhook headers, raw body, environment, and runtime configuration.
   * @returns The signature-verified webhook body parsed as JSON.
   */
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
    let payload: unknown;
    try {
      payload = JSON.parse(context.rawBody);
    } catch {
      throw badRequest("BVNK webhook body must be valid JSON", {
        provider: this.provider,
      });
    }
    const timestamp = z.object({ timestamp: z.string() }).safeParse(payload);
    await verifyWebhookSignature({
      provider: this.provider,
      signedPayload: context.rawBody,
      signature,
      algorithm: { type: "hmac-sha256", secret, encoding: "base64" },
      timestampSeconds: timestamp.success
        ? Date.parse(timestamp.data.timestamp) / 1000
        : Number.NaN,
    });
    return payload;
  }

  /**
   * Parses a verified BVNK webhook payload into a typed event.
   * @param payload - The signature-verified webhook JSON.
   * @returns A parsed event, or an ignore signal for events SDP does not handle.
   */
  parse(payload: unknown): BvnkParsedWebhook {
    const envelope = bvnkWebhookEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw badRequest("BVNK webhook is missing an event", { provider: this.provider });
    }
    const event = bvnkWebhookEventSchema.safeParse(envelope.data.event);
    if (!event.success) {
      return { event: "ignore", reason: `unsupported_event:${envelope.data.event}` };
    }
    if (envelope.data.data === undefined) {
      throw badRequest(`BVNK webhook "${envelope.data.event}" is missing a data object`, {
        provider: this.provider,
      });
    }
    const parsed = bvnkWebhookSchema.safeParse(payload);
    if (parsed.success) {
      return parsed.data;
    }
    throw badRequest(`BVNK webhook "${envelope.data.event}" failed validation`, {
      provider: this.provider,
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  /**
   * Applies a parsed BVNK webhook event.
   * @param env - Process environment used for repository access.
   * @param environment - Sandbox or production ramp environment.
   * @param webhook - The parsed webhook event.
   */
  async process(env: Env, environment: SdpEnvironment, webhook: BvnkParsedWebhook): Promise<void> {
    switch (webhook.event) {
      case "ignore":
        getLogger().info(`[bvnk webhook] ignored event: ${webhook.reason}`);
        return;
      case "bvnk:payment:payin:status-change":
        return handleBvnkPayinStatusChange(env, environment, webhook.data);
      case "payment:v2:payin:status-change":
        getLogger().info(
          { payin_id: webhook.data.id, status: webhook.data.status },
          "[bvnk webhook] v2 pay-in acknowledged-ignored"
        );
        return;
      case "bvnk:payment:crypto:status-change":
        return handleBvnkCryptoPayoutStatusChange(env, environment, webhook.data);
      case "bvnk:payment:channel:transaction-detected":
        return handleBvnkPaymentChannelTransactionDetected(env, environment, webhook);
      case "bvnk:payment:channel:transaction-confirmed":
        return handleBvnkPaymentChannelTransactionConfirmed(env, environment, webhook);
      case "bvnk:platform:customer:status-change":
        return handleBvnkCustomerStatusChange(env, environment, webhook);
      case "bvnk:platform:customer:update":
        return handleBvnkPlatformCustomerUpdate(env, environment, webhook);
      case "bvnk:platform:customer:agreement-session-status-change":
        return handleBvnkPlatformCustomerAgreementSessionStatusChange(env, environment, webhook);
      case "ledger:v2:wallet:status-change":
      case "bvnk:ledger:wallet:create":
        return applyBvnkWalletEvent(
          env,
          environment,
          parseBvnkWalletName(webhook.data.name),
          webhook.data
        );
      default: {
        const exhaustive: never = webhook;
        return exhaustive;
      }
    }
  }
}
