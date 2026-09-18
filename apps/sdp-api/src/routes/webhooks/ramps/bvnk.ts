import {
  BVNK_FUNDING_WALLET_FIAT,
  type BVNKWallet,
  type BvnkUnrecognisedWalletName,
  isBvnkCustomerVerified,
  isBvnkWalletActive,
  parseBvnkCustomerExternalReference,
  parseBvnkWalletName,
  readBvnkOfframpReference,
  withBvnkOfframpWalletStatus,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
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
  createPostgresCounterpartyProviderAccountsRepository,
  createSystemCounterpartiesRepository,
} from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { bvnkFundingWalletLockSchema } from "@/db/repositories/counterparty-provider-account.repository";
import { AppError, badRequest, internalError, providerNotConfigured } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import {
  type BvnkProvisioningAudit,
  deactivateBvnkRules,
  ensureBvnkFundingWallet,
  refreshBvnkCustomerAccount,
} from "@/routes/payments/handlers/ramps/bvnk";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import type { Env } from "@/types/env";
import {
  type BvnkWalletWebhookData,
  type BvnkWebhook,
  bvnkCryptoPayoutStatusSchema,
  bvnkWebhookEnvelopeSchema,
  bvnkWebhookEventSchema,
  bvnkWebhookSchema,
  isBvnkPayinStatus,
} from "./bvnk.schema";
import { TerminalRampWebhookError, type WebhookProcessor } from "./processor";

type BvnkParsedWebhook = BvnkWebhook | { event: "ignore"; reason: string };

function webhookRampContext(env: Env, environment: SdpEnvironment): RampRuntimeContext {
  return { env: env as unknown as Record<string, string | undefined>, mode: environment };
}

/**
 * Applies a BVNK fiat pay-in status-change event: verifies the pay-in names a
 * funding wallet a transfer is locked on and that wallet's customer, records
 * the pay-in id on the lock, and moves the transfer to settling with the
 * observed fiat amount. A replay is acknowledged; a pay-in for an unknown
 * wallet, an unlocked wallet, a different customer, or a second pay-in while
 * the lock is held is logged per the stray-pay-in rule and writes nothing.
 *
 * @param env - Process environment used for repository access.
 * @param data - Parsed pay-in status-change event data.
 * @returns Resolves once the transition is applied or the event is acknowledged.
 */
async function handleBvnkPayinStatusChange(
  env: Env,
  data: Extract<BvnkWebhook, { event: "payment:v2:payin:status-change" }>["data"]
): Promise<void> {
  if (!isBvnkPayinStatus(data.status)) {
    getLogger().info(
      { payin_id: data.id, status: data.status },
      "[bvnk webhook] pay-in status ignored"
    );
    return;
  }
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const row = await accounts.findActiveFundingWalletByReference({
    provider: "bvnk",
    externalAccountReference: data.beneficiary.walletId,
  });
  if (row === null) {
    getLogger().error(
      { wallet_id: data.beneficiary.walletId, payin_id: data.id },
      "[bvnk webhook] stray pay-in: unknown wallet"
    );
    return;
  }
  if (row.provider_customer_reference !== data.beneficiary.customerId) {
    throw internalError(
      `BVNK pay-in ${data.id} names customer ${data.beneficiary.customerId}, not the funding wallet's ${row.provider_customer_reference}`
    );
  }
  if (row.provider_status !== BVNK_FUNDING_WALLET_STATUS.locked) {
    getLogger().error(
      {
        counterparty_id: row.counterparty_id,
        wallet_id: row.external_account_reference,
        payin_id: data.id,
        amount: data.beneficiary.amount,
      },
      "[bvnk webhook] stray pay-in: wallet not locked"
    );
    return;
  }
  const lock = bvnkFundingWalletLockSchema.parse(row.metadata);
  const recorded = await accounts.recordFundingWalletPayin({
    organizationId: row.organization_id,
    projectId: row.project_id,
    counterpartyId: row.counterparty_id,
    provider: "bvnk",
    id: row.id,
    transferId: lock.transferId,
    payinId: data.id,
  });
  if (recorded === null) {
    if (lock.payinId === data.id) {
      getLogger().info(
        { counterparty_id: row.counterparty_id, payin_id: data.id },
        "[bvnk webhook] pay-in replay"
      );
      return;
    }
    getLogger().error(
      {
        counterparty_id: row.counterparty_id,
        wallet_id: row.external_account_reference,
        payin_id: data.id,
      },
      "[bvnk webhook] second pay-in while locked"
    );
    return;
  }
  await applyRampSettlementEvent(env, {
    provider: "bvnk",
    kind: "settling",
    reference: lock.transferId,
    providerCustomerId: data.beneficiary.customerId,
    receivedAmount: data.beneficiary.amount,
  });
  getLogger().info(
    {
      counterparty_id: row.counterparty_id,
      transfer_id: lock.transferId,
      payin_id: data.id,
    },
    "[bvnk webhook] pay-in settling transfer"
  );
}

/**
 * Applies a BVNK crypto payout status-change event for an on-ramp conversion:
 * verifies the payout's wallet and pay-in match the transfer's lock, then
 * either refreshes the transfer into settling (PROCESSING) or settles it
 * (COMPLETE) with the delivered crypto, the on-chain transaction, and the
 * full conversion economics. A COMPLETE that really settled the transfer also
 * deactivates the transfer's payment rule and releases the funding wallet;
 * deactivation or release failures propagate and heal on the next read. All
 * other inputs — non-`OUT` payouts, unknown wallets, unmatched pay-ins,
 * unknown statuses — are logged and write nothing.
 *
 * @param env - Process environment used for repository access.
 * @param environment - Sandbox or production ramp environment.
 * @param data - Parsed crypto payout status-change event data.
 * @returns Resolves once the transition is applied or the event is acknowledged.
 */
async function handleBvnkCryptoPayoutStatusChange(
  env: Env,
  environment: SdpEnvironment,
  data: Extract<BvnkWebhook, { event: "bvnk:payment:crypto:status-change" }>["data"]
): Promise<void> {
  if (data.type !== "OUT" || data.reference === null || !data.reference.startsWith("ON_RAMP_")) {
    getLogger().info(
      { payout_id: data.uuid, type: data.type },
      "[bvnk webhook] crypto payout is not an on-ramp conversion"
    );
    return;
  }
  const payinId = data.reference.slice("ON_RAMP_".length);
  const parsedStatus = bvnkCryptoPayoutStatusSchema.safeParse(data.status);
  if (!parsedStatus.success) {
    getLogger().warn(
      { payout_id: data.uuid, status: data.status },
      "[bvnk webhook] crypto payout status ignored"
    );
    return;
  }
  const status = parsedStatus.data;
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const row = await accounts.findActiveFundingWalletByReference({
    provider: "bvnk",
    externalAccountReference: data.walletId,
  });
  if (row === null) {
    getLogger().error(
      { wallet_id: data.walletId, payout_id: data.uuid },
      "[bvnk webhook] stray payout: unknown wallet"
    );
    return;
  }
  if (row.provider_status !== BVNK_FUNDING_WALLET_STATUS.locked) {
    getLogger().error(
      {
        counterparty_id: row.counterparty_id,
        wallet_id: data.walletId,
        payout_id: data.uuid,
      },
      "[bvnk webhook] stray payout: wallet not locked"
    );
    return;
  }
  const lock = bvnkFundingWalletLockSchema.parse(row.metadata);
  if (lock.payinId !== payinId) {
    getLogger().error(
      {
        counterparty_id: row.counterparty_id,
        wallet_id: row.external_account_reference,
        payout_payin_id: payinId,
      },
      "[bvnk webhook] payout for another pay-in"
    );
    return;
  }
  switch (status) {
    case "PROCESSING":
      await applyRampSettlementEvent(env, {
        provider: "bvnk",
        kind: "settling",
        reference: lock.transferId,
      });
      return;
    case "COMPLETE": {
      if (data.transactions.length === 0) {
        throw internalError("BVNK payout COMPLETE without a transaction hash");
      }
      if (data.address === null) {
        throw internalError("BVNK payout COMPLETE without a destination address");
      }
      const applied = await applyRampSettlementEvent(env, {
        provider: "bvnk",
        kind: "settled",
        reference: lock.transferId,
        receivedAmount: data.paidCurrency.actual,
        onchain: {
          signature: data.transactions[0].hash,
          destinationAddress: data.address.address,
          amount: data.paidCurrency.actual,
        },
        settlement: {
          provider: "bvnk",
          status: "COMPLETE",
          payinId,
          payoutId: data.uuid,
          fiatCurrency: data.walletCurrency.currency,
          fiatAmount: data.walletCurrency.actual,
          cryptoCurrency: data.paidCurrency.currency,
          cryptoAmount: data.paidCurrency.actual,
          feeCurrency: data.feeCurrency.currency,
          feeAmount: data.feeCurrency.actual,
          exchangeRate: data.exchangeRate.rate,
          txHash: data.transactions[0].hash,
        },
      });
      if (!applied) {
        return;
      }
      if (row.external_account_reference === null) {
        throw internalError("BVNK funding wallet reference is not assigned yet.");
      }
      await deactivateBvnkRules(webhookRampContext(env, environment), {
        walletId: row.external_account_reference,
        transferId: lock.transferId,
      });
      const released = await accounts.releaseFundingWallet({
        organizationId: row.organization_id,
        projectId: row.project_id,
        counterpartyId: row.counterparty_id,
        provider: "bvnk",
        id: row.id,
        transferId: lock.transferId,
      });
      if (released === null) {
        getLogger().info(
          { counterparty_id: row.counterparty_id, transfer_id: lock.transferId },
          "[bvnk webhook] funding wallet already released"
        );
      }
      return;
    }
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * Applies the shared tail of a BVNK customer-state webhook: resolves the
 * counterparty's customer-link row and records the event's state (a verified
 * status patch or a provider refresh). A verified status patch also advances
 * the funding-wallet claim so the requirements gate can open once BVNK
 * activates the wallet.
 *
 * @param env - Process environment used for repository access.
 * @param environment - Sandbox or production ramp environment.
 * @param counterparty - Counterparty the event targets.
 * @param eventName - Parsed BVNK event name, used in the missing-link log.
 * @param options - Whether to refresh the provider account, or patch the verified status the event carries.
 * @returns Resolves once customer state is applied.
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
 * counterparty by the provider customer reference the event carries, then
 * either applies the verified status patch or refreshes the provider account
 * for any other status.
 *
 * @param env - Process environment used for repository access.
 * @param environment - Sandbox or production ramp environment.
 * @param event - Parsed v2 platform customer status-change event.
 * @returns Resolves once customer state and pending on-ramp provisioning are applied.
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
  });
  if (!counterparty) {
    throw internalError(
      `BVNK webhook customer ${event.data.reference} was not found or is not active`
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
    throw internalError(
      `BVNK webhook customer ${event.data.reference} was not found or is not active`
    );
  }
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyById(counterpartyId);
  if (!counterparty) {
    throw internalError(
      `BVNK webhook customer ${event.data.reference} was not found or is not active`
    );
  }
  await applyBvnkCustomerStateWebhook(env, environment, counterparty, event.event, {
    refresh: true,
  });
}

/**
 * Records a provider-confirmed BVNK agreement-session signature.
 *
 * @param env - Process environment used for repository access.
 * @param event - Parsed BVNK agreement-session status-change event.
 * @returns Resolves once the signature transition is recorded or a replay is acknowledged.
 */
async function handleBvnkPlatformCustomerAgreementSessionStatusChange(
  env: Env,
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
  });
  if (row === null) {
    throw internalError(`BVNK agreement session ${sessionReference} has no customer link`);
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
 * Builds the system provisioning audit for webhook-driven BVNK provisioning.
 * Webhook-driven provisioning has no request actor; the system
 * intent/outcome pair still records what was created and why, and an
 * unresolved intent pages like any other.
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
        { metadata }
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
  wallet: Extract<BVNKWallet, { kind: "merchant_offramp" }>,
  status: string
): Promise<void> {
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyById(wallet.counterpartyId);
  if (!counterparty) {
    throw new TerminalRampWebhookError(
      `BVNK webhook counterparty ${wallet.counterpartyId} was not found or is not active`
    );
  }
  // TODO(PRO-1824): Move BVNK merchant-wallet state to counterparty_provider_accounts.
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
 * to the claimed funding row, then CAS-advances the row from provisioning to
 * provisioned. Nothing else from the event is persisted; bank details stay
 * JIT. A non-ACTIVE status or a replay after provisioning is logged and
 * acknowledged. An event whose wallet id or customer diverges from the
 * claimed row is terminal — a duplicate or foreign wallet can never become
 * the row's reference, so the ingest row parks and is never retried. An
 * event arriving before the reference is assigned is transient: the assign
 * has not landed, so it fails loudly and replay heals it.
 *
 * @param env - Process environment used for repository access.
 * @param wallet - Parsed funding-wallet name carrying the customer-link row id.
 * @param data - Parsed status-change event data.
 * @returns Resolves once the status transition is applied or the event is acknowledged.
 */
async function handleBvnkFundingWalletStatusChange(
  env: Env,
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
  });
  if (row === null) {
    throw internalError(
      `BVNK funding wallet event references no claimed funding row for customer link ${wallet.providerAccountId}`
    );
  }
  if (row.external_account_reference === null) {
    throw internalError("BVNK funding wallet reference is not assigned yet.");
  }
  if (row.external_account_reference !== data.id) {
    getLogger().error(
      {
        provider_account_id: row.id,
        stored_wallet_id: row.external_account_reference,
        event_wallet_id: data.id,
        customer_id: row.counterparty_id,
      },
      "[bvnk webhook] funding wallet event for an orphan duplicate wallet"
    );
    throw new TerminalRampWebhookError("BVNK funding wallet event targets a different wallet.");
  }
  if (row.provider_customer_reference !== data.customer.id) {
    getLogger().error(
      {
        provider_account_id: row.id,
        stored_customer_reference: row.provider_customer_reference,
        event_customer_id: data.customer.id,
        customer_id: row.counterparty_id,
      },
      "[bvnk webhook] funding wallet event for a different customer"
    );
    throw new TerminalRampWebhookError("BVNK funding wallet belongs to another customer.");
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
 * Applies a wallet lifecycle event by its parsed name. Merchant off-ramp and
 * funding-wallet names route to their handlers; any other name — including the
 * legacy 6-part rule-keyed on-ramp wallets sandbox still holds — is
 * acknowledged as terminal: SDP no longer manages those wallets, so the event
 * is never retried.
 *
 * @param env - Process environment used for repository access.
 * @param wallet - Parsed wallet name, or the unrecognised name itself.
 * @param data - Parsed status-change event data.
 * @returns Resolves once the status transition is applied or the event is acknowledged.
 */
async function applyBvnkWalletEvent(
  env: Env,
  wallet: BVNKWallet | BvnkUnrecognisedWalletName,
  data: BvnkWalletWebhookData
): Promise<void> {
  switch (wallet.kind) {
    case "merchant_offramp":
      if (!data.status) {
        getLogger().info("[bvnk webhook] merchant off-ramp wallet event is missing status");
        return;
      }
      return handleBvnkOfframpWalletWebhook(env, wallet, data.status);
    case "funding_wallet": {
      if (!("id" in data)) {
        getLogger().info(
          { provider_account_id: wallet.providerAccountId, status: data.status },
          "[bvnk webhook] funding wallet lifecycle event"
        );
        return;
      }
      return handleBvnkFundingWalletStatusChange(env, wallet, data);
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
 * Applies an off-ramp channel settlement transition with its terminal amount.
 *
 * @param env - Process environment used for database access.
 * @param transferId - SDP off-ramp transfer identifier.
 * @param status - Settlement status to apply.
 * @param walletAmount - Confirmed wallet amount, when BVNK has supplied one.
 * @returns Resolves once the guarded transfer update completes.
 */
async function settleBvnkOfframpChannel(
  env: Env,
  transferId: string,
  status: "settling" | "completed",
  walletAmount: string | null
): Promise<void> {
  const placeholders = buildInClause(NON_TERMINAL_RAMP_TRANSFER_STATUSES.length);
  const updatedAt = new Date().toISOString();
  await getDb(env)
    .prepare(
      `UPDATE payment_transfers
       SET status = ?,
           fiat_amount = CASE WHEN ?::boolean THEN ? ELSE fiat_amount END,
           updated_at = ?
       WHERE id = ?
         AND provider = 'bvnk'
         AND type = 'offramp'
         AND status IN (${placeholders})`
    )
    .bind(
      status,
      walletAmount !== null,
      walletAmount,
      updatedAt,
      transferId,
      ...NON_TERMINAL_RAMP_TRANSFER_STATUSES
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
  event: Extract<BvnkWebhook, { event: "bvnk:payment:channel:transaction-detected" }>
): Promise<void> {
  const transferId = bvnkChannelTransferId(event);
  if (transferId === undefined) {
    return;
  }
  await settleBvnkOfframpChannel(env, transferId, "settling", null);
}

async function handleBvnkPaymentChannelTransactionConfirmed(
  env: Env,
  event: Extract<BvnkWebhook, { event: "bvnk:payment:channel:transaction-confirmed" }>
): Promise<void> {
  const transferId = bvnkChannelTransferId(event);
  if (transferId === undefined) {
    return;
  }
  await settleBvnkOfframpChannel(env, transferId, "completed", event.data.walletAmount);
}

export class BvnkWebhookProcessor implements WebhookProcessor<unknown, BvnkParsedWebhook> {
  readonly provider = "bvnk";

  /**
   * Verifies a BVNK webhook against the configured HMAC secret.
   *
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
   *
   * @param payload - The signature-verified webhook JSON.
   * @returns A parsed webhook event, or an ignore signal for events SDP does not handle.
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
   *
   * @param env - Process environment used for repository access.
   * @param environment - Sandbox or production ramp environment.
   * @param webhook - The parsed webhook event.
   * @returns Resolves once the event's effects are applied.
   */
  async process(env: Env, environment: SdpEnvironment, webhook: BvnkParsedWebhook): Promise<void> {
    switch (webhook.event) {
      case "ignore":
        getLogger().info(`[bvnk webhook] ignored event: ${webhook.reason}`);
        return;
      case "payment:v2:payin:status-change":
        return handleBvnkPayinStatusChange(env, webhook.data);
      case "bvnk:payment:crypto:status-change":
        return handleBvnkCryptoPayoutStatusChange(env, environment, webhook.data);
      case "bvnk:payment:channel:transaction-detected":
        return handleBvnkPaymentChannelTransactionDetected(env, webhook);
      case "bvnk:payment:channel:transaction-confirmed":
        return handleBvnkPaymentChannelTransactionConfirmed(env, webhook);
      case "bvnk:platform:customer:status-change":
        return handleBvnkCustomerStatusChange(env, environment, webhook);
      case "bvnk:platform:customer:update":
        return handleBvnkPlatformCustomerUpdate(env, environment, webhook);
      case "bvnk:platform:customer:agreement-session-status-change":
        return handleBvnkPlatformCustomerAgreementSessionStatusChange(env, webhook);
      case "ledger:v2:wallet:status-change":
      case "bvnk:ledger:wallet:create":
        return applyBvnkWalletEvent(env, parseBvnkWalletName(webhook.data.name), webhook.data);
      default: {
        const exhaustive: never = webhook;
        return exhaustive;
      }
    }
  }
}
