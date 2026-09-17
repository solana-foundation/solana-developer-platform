import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  isBvnkWalletActive,
  readBvnkOfframpReference,
  withBvnkOfframpWalletStatus,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { bvnkOnrampTransferProviderDataSchema } from "@sdp/payments/ramps/providers/bvnk/schemas";
import type { RampRuntimeContext, RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import {
  NON_TERMINAL_RAMP_TRANSFER_STATUSES,
  type SdpEnvironment,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import { z } from "zod";
import { getDb } from "@/db";
import { buildInClause } from "@/db/postgres-utils";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { createSystemCounterpartiesRepository, createSystemPaymentsRepository } from "@/db/repositories";
import { AppError, badRequest, providerNotConfigured } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { resolveBvnkOnrampRule } from "@/routes/payments/handlers/ramps/bvnk";
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

async function handleBvnkPaymentPayinStatusChange(
  env: Env,
  environment: SdpEnvironment,
  event: Extract<BvnkWebhook, { event: "bvnk:payment:payin:status-change" }>
): Promise<void> {
  if (event.data.status !== "COMPLETED") {
    return;
  }
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const wallet = await accounts.getProviderAccountByExternalReference({
    provider: "bvnk",
    externalAccountReference: event.data.beneficiary.walletId,
  });
  if (wallet === null) {
    throw new TerminalRampWebhookError(
      `BVNK webhook wallet ${event.data.beneficiary.walletId} has no provider-account row`
    );
  }
  const payments = createSystemPaymentsRepository(env);
  const transfer = await payments.getInFlightBvnkOnrampTransferByFundingWallet({
    fundingWalletAccountId: wallet.id,
  });
  if (transfer === null) {
    throw new TerminalRampWebhookError(
      `BVNK webhook payin ${event.data.uuid} has no in-flight onramp transfer for funding wallet ${wallet.id}`
    );
  }
  const bvnk = bvnkOnrampTransferProviderDataSchema.parse(transfer.provider_data).bvnk;
  if (bvnk.ruleId === undefined) {
    await resolveBvnkOnrampRule(
      payments,
      webhookRampContext(env, environment),
      transfer,
      event.data.beneficiary.walletId,
      null
    );
  }
  if (bvnk.appliedPayinId === event.data.uuid) {
    getLogger().info(
      `[bvnk webhook] pay-in ${event.data.uuid} already applied to transfer ${transfer.id}`
    );
    return;
  }
  const paymentAmount = event.data.amount.value;
  const settled = await payments.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    fromStatuses: ["awaiting_payment"],
    toStatus: "settling",
    fiatAmount: paymentAmount,
    // provider_data merges shallowly, so the bvnk object is rewritten whole.
    providerData: {
      bvnk: { ...bvnk, creditedFiatAmount: paymentAmount, appliedPayinId: event.data.uuid },
    },
    updatedAt: new Date().toISOString(),
  });
  if (settled === null) {
    getLogger().warn(
      `[bvnk webhook] pay-in ${event.data.uuid} lost the settling claim for transfer ${transfer.id}`
    );
  }
}

async function handleBvnkPaymentCryptoStatusChange(
  env: Env,
  environment: SdpEnvironment,
  event: Extract<BvnkWebhook, { event: "bvnk:payment:crypto:status-change" }>
): Promise<void> {
  if (event.data.type !== "OUT" || event.data.status !== "COMPLETED") {
    return;
  }
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const wallet = await accounts.getProviderAccountByExternalReference({
    provider: "bvnk",
    externalAccountReference: event.data.walletId,
  });
  if (wallet === null) {
    getLogger().info(
      `[bvnk webhook] crypto event ${event.data.uuid} references untracked wallet ${event.data.walletId}`
    );
    return;
  }
  const payments = createSystemPaymentsRepository(env);
  const transfer = await payments.getInFlightBvnkOnrampTransferByFundingWallet({
    fundingWalletAccountId: wallet.id,
  });
  if (transfer === null) {
    getLogger().info(
      `[bvnk webhook] crypto event ${event.data.uuid} has no in-flight onramp transfer for funding wallet ${wallet.id}`
    );
    return;
  }
  const completed = await payments.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    fromStatuses: ["settling"],
    toStatus: "completed",
    updatedAt: new Date().toISOString(),
  });
  if (completed === null) {
    getLogger().info(
      `[bvnk webhook] crypto event ${event.data.uuid} transfer ${transfer.id} is not settling anymore`
    );
    return;
  }
  const bvnk = bvnkOnrampTransferProviderDataSchema.parse(transfer.provider_data).bvnk;
  if (bvnk.ruleId === undefined) {
    return;
  }
  try {
    await RAMP_PROVIDER_CLIENTS.bvnk.deactivateOnrampRule(
      webhookRampContext(env, environment),
      { ruleId: bvnk.ruleId }
    );
  } catch (error) {
    getLogger().error(
      `sdp_api_bvnk_rule_deactivate_failed rule=${bvnk.ruleId} transfer=${transfer.id} error=${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function handleBvnkFundingWalletWebhook(
  env: Env,
  wallet: CounterpartyProviderAccountRow,
  status: string
): Promise<void> {
  const updated = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(env)
  ).updateVirtualFundingWalletStatus({
    organizationId: wallet.organization_id,
    projectId: wallet.project_id,
    counterpartyId: wallet.counterparty_id,
    provider: "bvnk",
    id: wallet.id,
    providerStatus: status,
  });
  if (updated === null) {
    throw new TerminalRampWebhookError(
      `BVNK webhook funding wallet ${wallet.id} was not found in its tenant scope`
    );
  }
}

async function handleBvnkOfframpWalletWebhook(
  env: Env,
  wallet: CounterpartyProviderAccountRow,
  status: string
): Promise<void> {
  if (wallet.fiat_currency === null) {
    throw new TerminalRampWebhookError(
      `BVNK webhook merchant wallet ${wallet.id} has no fiat currency`
    );
  }
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findActiveCounterpartyById(wallet.counterparty_id);
  if (!counterparty) {
    throw new TerminalRampWebhookError(
      `BVNK webhook counterparty ${wallet.counterparty_id} was not found or is not active`
    );
  }
  // TODO(PRO-1824): Move BVNK merchant-wallet state to counterparty_provider_accounts.
  await repo.mutateProviderData({
    counterpartyId: counterparty.id,
    organizationId: counterparty.organization_id,
    projectId: counterparty.project_id,
    mutate: (providerData) =>
      withBvnkOfframpWalletStatus(providerData, wallet.fiat_currency as RampFiatCurrency, status),
  });
}

async function applyBvnkWalletEvent(
  env: Env,
  wallet: CounterpartyProviderAccountRow,
  data: BvnkWalletWebhookData
): Promise<void> {
  switch (wallet.kind) {
    case "virtual_funding_wallet":
      if (isBvnkWalletActive(data.status)) {
        await handleBvnkFundingWalletWebhook(env, wallet, data.status);
      }
      return;
    case "merchant_wallet":
      await handleBvnkOfframpWalletWebhook(env, wallet, data.status);
      return;
    default:
      getLogger().info(
        `[bvnk webhook] wallet ${wallet.id} (kind ${wallet.kind}) has no tracked BVNK wallet handler`
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
      case "bvnk:payment:payin:status-change":
        return handleBvnkPaymentPayinStatusChange(env, environment, webhook);
      case "bvnk:payment:crypto:status-change":
        return handleBvnkPaymentCryptoStatusChange(env, environment, webhook);
      case "bvnk:payment:channel:transaction-detected":
        return handleBvnkPaymentChannelTransactionDetected(env, webhook);
      case "bvnk:payment:channel:transaction-confirmed":
        return handleBvnkPaymentChannelTransactionConfirmed(env, webhook);
      case "ledger:v2:wallet:status-change":
      case "bvnk:ledger:wallet:create": {
        const wallet = await createPostgresCounterpartyProviderAccountsRepository(
          getDb(env)
        ).getProviderAccountByExternalReference({
          provider: "bvnk",
          externalAccountReference: webhook.data.id,
        });
        if (wallet === null) {
          getLogger().info(`[bvnk webhook] wallet ${webhook.data.id} has no provider-account row`);
          return;
        }
        return applyBvnkWalletEvent(env, wallet, webhook.data);
      }
      default: {
        const exhaustive: never = webhook;
        return exhaustive;
      }
    }
  }
}
