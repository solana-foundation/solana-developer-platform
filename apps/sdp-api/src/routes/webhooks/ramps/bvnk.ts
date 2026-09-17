import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  isBvnkWalletActive,
  readBvnkOfframpReference,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { bvnkOnrampTransferProviderDataSchema } from "@sdp/payments/ramps/providers/bvnk/schemas";
import type { RampRuntimeContext, RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { createSystemPaymentsRepository } from "@/db/repositories";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
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
    await RAMP_PROVIDER_CLIENTS.bvnk.deactivateOnrampRule(webhookRampContext(env, environment), {
      ruleId: bvnk.ruleId,
    });
    await payments.markBvnkOnrampRuleDeactivated({
      transferId: transfer.id,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
      updatedAt: new Date().toISOString(),
    });
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

/**
 * Flips a virtual settlement wallet row active with the wallet-status
 * webhook's provider status; stores nothing else.
 *
 * @param env - Process environment used for database access.
 * @param wallet - The settlement wallet provider-account row.
 * @param status - The provider status reported by the webhook.
 * @returns Resolves once the row is updated.
 */
async function handleBvnkSettlementWalletWebhook(
  env: Env,
  wallet: CounterpartyProviderAccountRow,
  status: string
): Promise<void> {
  const updated = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(env)
  ).updateVirtualSettlementWalletStatus({
    organizationId: wallet.organization_id,
    projectId: wallet.project_id,
    counterpartyId: wallet.counterparty_id,
    provider: "bvnk",
    id: wallet.id,
    providerStatus: status,
  });
  if (updated === null) {
    throw new TerminalRampWebhookError(
      `BVNK webhook settlement wallet ${wallet.id} was not found in its tenant scope`
    );
  }
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
    case "virtual_settlement_wallet":
      if (isBvnkWalletActive(data.status)) {
        await handleBvnkSettlementWalletWebhook(env, wallet, data.status);
      }
      return;
    default:
      getLogger().info(
        `[bvnk webhook] wallet ${wallet.id} (kind ${wallet.kind}) has no tracked BVNK wallet handler`
      );
  }
}

/**
 * Applies the confirmed off-ramp channel transition in one compare-and-swap:
 * CAS's the transfer from `awaiting_payment` or `settling` to `completed` and
 * records the credited fiat amount once (a JSONB guard refuses to overwrite an
 * earlier credit). A redelivered or racing confirmation is a no-op.
 *
 * @param env - Process environment used for database access.
 * @param transfer - The resolved BVNK off-ramp transfer.
 * @param walletAmount - Confirmed fiat amount BVNK credited to the wallet.
 * @returns Resolves once the guarded transfer update completes.
 */
async function settleBvnkOfframpChannel(
  env: Env,
  transfer: PaymentTransferRow,
  walletAmount: string
): Promise<void> {
  const updated = await createSystemPaymentsRepository(env).bindBvnkOfframpCredit({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    creditedFiatAmount: walletAmount,
    updatedAt: new Date().toISOString(),
  });
  if (updated === null) {
    getLogger().info(
      `[bvnk webhook] channel confirmation for transfer ${transfer.id} lost the completion claim or was already credited`
    );
  }
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
  const payments = createSystemPaymentsRepository(env);
  const transfer = await payments.getBvnkOfframpTransferById({ transferId });
  if (transfer === null) {
    getLogger().info(
      `[bvnk webhook] channel ${event.data.channelId} references unknown off-ramp transfer ${transferId}`
    );
    return;
  }
  const settled = await payments.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    fromStatuses: ["awaiting_payment"],
    toStatus: "settling",
    updatedAt: new Date().toISOString(),
  });
  if (settled === null) {
    getLogger().warn(
      `[bvnk webhook] channel ${event.data.channelId} lost the settling claim for transfer ${transferId}`
    );
  }
}

async function handleBvnkPaymentChannelTransactionConfirmed(
  env: Env,
  event: Extract<BvnkWebhook, { event: "bvnk:payment:channel:transaction-confirmed" }>
): Promise<void> {
  const transferId = bvnkChannelTransferId(event);
  if (transferId === undefined) {
    return;
  }
  const payments = createSystemPaymentsRepository(env);
  const transfer = await payments.getBvnkOfframpTransferById({ transferId });
  if (transfer === null) {
    getLogger().info(
      `[bvnk webhook] channel ${event.data.channelId} references unknown off-ramp transfer ${transferId}`
    );
    return;
  }
  await settleBvnkOfframpChannel(env, transfer, event.data.walletAmount);
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
