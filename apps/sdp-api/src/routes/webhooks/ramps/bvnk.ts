import { readRecord } from "@sdp/payments/json";
import {
  type BVNKWallet,
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
  FUNDABLE_RAMP_TRANSFER_STATUSES,
  NON_TERMINAL_RAMP_TRANSFER_STATUSES,
  type SdpEnvironment,
} from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import { buildInClause } from "@/db/postgres-utils";
import {
  createPostgresCounterpartyProviderAccountsRepository,
  createSystemCounterpartiesRepository,
  createSystemPaymentsRepository,
} from "@/db/repositories";
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";
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
  type BvnkWalletWebhookData,
  type BvnkWebhook,
  bvnkWebhookEnvelopeSchema,
  bvnkWebhookEventSchema,
  bvnkWebhookSchema,
} from "./bvnk.schema";
import { TerminalRampWebhookError, type WebhookProcessor } from "./processor";

type BvnkParsedWebhook = BvnkWebhook | { event: "ignore"; reason: string };

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

async function handleBvnkPaymentPayinStatusChange(
  env: Env,
  event: Extract<BvnkWebhook, { event: "bvnk:payment:payin:status-change" }>
): Promise<void> {
  if (event.data.status !== "COMPLETED") {
    return;
  }
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyByProviderCustomerReference({
    provider: "bvnk",
    providerCustomerReference: event.data.customerReference,
  });
  if (!counterparty) {
    throw new TerminalRampWebhookError(
      `BVNK webhook customer ${event.data.customerReference} was not found or is not active`
    );
  }
  const paymentAmount = event.data.amount.value;
  const payments = createSystemPaymentsRepository(env);
  // A replayed event that already settled a transfer must not re-match: the
  // settled row is excluded from the wallet+amount search, so a later
  // awaiting transfer with the same shape would become the "unique" match and
  // complete without a payment. The applied payin id on the settled row is
  // the dedupe marker.
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
    .bind(counterparty.organization_id, counterparty.project_id, counterparty.id, event.data.uuid)
    .first<{ id: string }>();
  if (alreadyApplied) {
    getLogger().info(
      `[bvnk webhook] pay-in ${event.data.uuid} already settled transfer ${alreadyApplied.id}`
    );
    return;
  }
  const matches = await getDb(env)
    .prepare(
      `SELECT id
       FROM payment_transfers
       WHERE organization_id = ?
         AND project_id IS NOT DISTINCT FROM ?
         AND counterparty_id = ?
         AND provider = 'bvnk'
         AND type = 'onramp'
         AND status IN (${buildInClause(FUNDABLE_RAMP_TRANSFER_STATUSES.length)})
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
      ...FUNDABLE_RAMP_TRANSFER_STATUSES,
      event.data.beneficiary.walletId,
      paymentAmount
    )
    .all<{ id: string }>();
  // BVNK pay-in events do not carry the SDP quote id. Only a unique active
  // wallet+amount match is safe; choosing the newest row can settle the wrong quote.
  if (matches.results.length !== 1) {
    getLogger().warn(
      `[bvnk webhook] refusing ambiguous pay-in settlement customer=${event.data.customerReference} wallet=${event.data.beneficiary.walletId} matches=${matches.results.length}`
    );
    return;
  }
  const transfer = await payments.getTransferById({
    transferId: matches.results[0].id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
  });
  if (!transfer) {
    return;
  }
  await payments.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    fromStatuses: FUNDABLE_RAMP_TRANSFER_STATUSES,
    toStatus: "completed",
    amount: paymentAmount,
    fiatAmount: paymentAmount,
    updatedAt: new Date().toISOString(),
    // provider_data merges shallowly, so the bvnk object is rewritten whole.
    providerData: {
      bvnk: { ...readRecord(transfer.provider_data.bvnk), appliedPayinId: event.data.uuid },
    },
  });
}

/**
 * Applies the shared tail of a BVNK customer-state webhook: resolves the
 * counterparty's customer-link row, records the event's state (a verified
 * status patch or a provider refresh), and provisions pending on-ramps.
 *
 * @param env - Process environment used for repository access.
 * @param environment - Sandbox or production ramp environment.
 * @param repo - Counterparty repository used for on-ramp provisioning.
 * @param counterparty - Counterparty the event targets.
 * @param eventName - Parsed BVNK event name, used in the missing-link log.
 * @param options - Whether to refresh the provider account, or patch the verified status the event carries.
 * @returns Resolves once customer state and pending on-ramp provisioning are applied.
 */
async function applyBvnkCustomerStateWebhook(
  env: Env,
  environment: SdpEnvironment,
  repo: CounterpartiesRepository,
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
  }
  await provisionPendingBvnkOnramps(env, repo, environment, counterparty);
}

async function handleBvnkCustomersStatusChange(
  env: Env,
  environment: SdpEnvironment,
  event: Extract<BvnkWebhook, { event: "bvnk:customers:status-change" }>
): Promise<void> {
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyByProviderCustomerReference({
    provider: "bvnk",
    providerCustomerReference: event.data.customerId,
  });
  if (!counterparty) {
    throw internalError(
      `BVNK webhook customer ${event.data.customerId} was not found or is not active`
    );
  }
  if (isBvnkCustomerVerified(event.data.status)) {
    await applyBvnkCustomerStateWebhook(env, environment, repo, counterparty, event.event, {
      refresh: false,
      status: event.data.status,
    });
    return;
  }
  await applyBvnkCustomerStateWebhook(env, environment, repo, counterparty, event.event, {
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
  await applyBvnkCustomerStateWebhook(env, environment, repo, counterparty, event.event, {
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

async function provisionPendingBvnkOnramps(
  env: Env,
  repo: CounterpartiesRepository,
  environment: SdpEnvironment,
  counterparty: CounterpartyRow
): Promise<void> {
  const ctx = webhookRampContext(env, environment);
  const currentCounterparty = await repo.findActiveCounterpartyById(counterparty.id);
  if (!currentCounterparty) {
    throw new TerminalRampWebhookError(
      `BVNK webhook counterparty ${counterparty.id} was not found or is not active`
    );
  }
  const customer = await readBvnkCustomerLink(env, currentCounterparty);
  if (!customer || !isBvnkCustomerVerified(customer.status)) {
    return;
  }
  const pendingKeys = pendingBvnkOnrampPaymentRuleKeys(currentCounterparty.provider_data);
  for (const key of pendingKeys) {
    const reloadedCounterparty = await repo.findActiveCounterpartyById(counterparty.id);
    if (!reloadedCounterparty) {
      throw new TerminalRampWebhookError(
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

async function handleBvnkOnrampWalletWebhook(
  env: Env,
  environment: SdpEnvironment,
  wallet: Extract<BVNKWallet, { direction: "onramp" }>,
  data: BvnkWalletWebhookData
): Promise<void> {
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyById(wallet.counterpartyId);
  if (!counterparty) {
    throw new TerminalRampWebhookError(
      `BVNK webhook counterparty ${wallet.counterpartyId} was not found or is not active`
    );
  }
  // withBvnkOnrampPaymentRuleState merges the partial over the stored entry,
  // so a key with an undefined value would erase the stored value; only
  // include keys the event actually carries.
  const state: Partial<BvnkOnrampPaymentRuleState> = {};
  if (data.status) {
    state.walletStatus = data.status;
  }
  if (data.bankAccount !== undefined) {
    state.bankAccount = data.bankAccount;
  }
  if (state.walletStatus !== undefined || state.bankAccount !== undefined) {
    await updateBvnkOnrampPaymentRuleState(repo, counterparty, wallet.onrampKey, state);
  }
  if (isBvnkWalletActive(data.status)) {
    await provisionPendingBvnkOnramps(env, repo, environment, counterparty);
  }
}

async function handleBvnkOfframpWalletWebhook(
  env: Env,
  wallet: Extract<BVNKWallet, { direction: "offramp" }>,
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

async function applyBvnkWalletEvent(
  env: Env,
  environment: SdpEnvironment,
  wallet: BVNKWallet,
  data: BvnkWalletWebhookData
): Promise<void> {
  switch (wallet.direction) {
    case "offramp":
      if (!data.status) {
        getLogger().info("[bvnk webhook] merchant off-ramp wallet event is missing status");
        return;
      }
      return handleBvnkOfframpWalletWebhook(env, wallet, data.status);
    case "onramp":
      return handleBvnkOnrampWalletWebhook(env, environment, wallet, data);
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
      case "bvnk:payment:payin:status-change":
        return handleBvnkPaymentPayinStatusChange(env, webhook);
      case "bvnk:payment:channel:transaction-detected":
        return handleBvnkPaymentChannelTransactionDetected(env, webhook);
      case "bvnk:payment:channel:transaction-confirmed":
        return handleBvnkPaymentChannelTransactionConfirmed(env, webhook);
      case "bvnk:customers:status-change":
        return handleBvnkCustomersStatusChange(env, environment, webhook);
      case "bvnk:platform:customer:update":
        return handleBvnkPlatformCustomerUpdate(env, environment, webhook);
      case "bvnk:platform:customer:agreement-session-status-change":
        return handleBvnkPlatformCustomerAgreementSessionStatusChange(env, webhook);
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
