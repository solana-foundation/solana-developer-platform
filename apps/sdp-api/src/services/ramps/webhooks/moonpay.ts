import { readRecord, readString } from "@sdp/payments/json";
import { moonpayCryptoRail } from "@sdp/payments/ramps/providers/moonpay/client";
import {
  type MoonpaySettlementEvent,
  moonpayBuyTransactionSchema,
  moonpaySellTransactionSchema,
  moonpaySellTransactionSettlementEvent,
  moonpayTransactionSettlementEvent,
} from "@sdp/payments/ramps/providers/moonpay/event-status-mapping";
import type { RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  isRampTransferType,
  isTerminalRampTransferStatus,
  RAMP_TRANSFER_TRANSITIONS,
  type RampWebhookProcessResult,
} from "@sdp/types/payments";
import { z } from "zod";
import { asTransactionalClient, getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createSystemTransactionalPaymentsRepository } from "@/db/repositories/repository-factory";
import { AppError, badRequest, providerNotConfigured } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import type { Env } from "@/types/env";
import type { WebhookProcessor } from "./processor";

/**
 * The key that signs `environment`'s MoonPay events. SDP holds the sandbox key
 * only: production projects bring their own MoonPay account (HOO-1942).
 */
function readMoonpayWebhookKey(
  env: Record<string, string | undefined>,
  environment: SdpEnvironment
): string {
  if (environment === "production") {
    throw providerNotConfigured("MoonPay webhooks are not configured for production.");
  }
  const webhookKey = env.MOONPAY_SANDBOX_WEBHOOK_KEY?.trim();
  if (!webhookKey) {
    throw providerNotConfigured(
      "MoonPay sandbox webhook key is not configured (MOONPAY_SANDBOX_WEBHOOK_KEY)."
    );
  }
  return webhookKey;
}

function parseMoonpaySignatureV2Header(
  header: string
): { timestamp: string; signature: string } | null {
  let timestamp: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const prefix = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (prefix === "t") {
      timestamp = value;
    }
    if (prefix === "s") {
      signature = value;
    }
  }

  return timestamp && signature ? { timestamp, signature } : null;
}

/** The crypto a MoonPay sale moves. Earlier sell events may omit it. */
const moonpaySoldCryptoSchema = z.object({
  baseCurrency: z.object({ code: z.string() }).optional(),
});

/**
 * A completed MoonPay transaction names the crypto it moved, so settlement can
 * refuse another asset. Earlier events may omit it; a completed one that does
 * is malformed, and the 400 makes MoonPay redeliver it.
 */
function withSettledAsset(
  type: string,
  event: MoonpaySettlementEvent,
  cryptoCode: string | undefined
): MoonpaySettlementEvent {
  if (event.kind !== "settled") {
    return event;
  }
  if (cryptoCode === undefined) {
    throw badRequest(
      `MoonPay "${type}" webhook carries a completed transaction without its crypto`,
      {
        provider: event.provider,
      }
    );
  }
  return { ...event, deliveredAssetRail: moonpayCryptoRail(cryptoCode) };
}

class RollBackMoonpayClaim extends Error {
  constructor(readonly result: RampWebhookProcessResult) {
    super("MoonPay observation did not apply");
  }
}

async function moonpayObservationPreflight(
  repo: PaymentsRepository,
  locked: { transfer: PaymentTransferRow; environment: SdpEnvironment } | null,
  environment: SdpEnvironment,
  event: Exclude<MoonpaySettlementEvent, { kind: "ignore" }>,
  ownerTransferId: string | null
): Promise<RampWebhookProcessResult | null> {
  if (!locked) return { outcome: "unmatched" };
  const { transfer } = locked;
  if (locked.environment !== environment) {
    logEvent("error", {
      event: "sdp_api_ramp_settlement_environment_mismatch",
      flow: "ramp-settlement",
      provider: event.provider,
      provider_reference: event.reference,
      transfer_id: event.transferId,
      environment,
      transfer_environment: locked.environment,
    });
    return { outcome: "refused", reason: "environment_mismatch" };
  }
  if (!isRampTransferType(transfer.type)) {
    return { outcome: "refused", reason: "transfer_type_mismatch" };
  }
  if (transfer.type !== event.rampType) {
    return { outcome: "refused", reason: "transfer_type_mismatch" };
  }
  if (ownerTransferId !== null && ownerTransferId !== transfer.id) {
    return { outcome: "refused", reason: "provider_reference_conflict" };
  }
  const retired = await repo.getFailedMoonpayTransaction(event.reference);
  if (retired) {
    if (retired.transferId !== event.transferId) {
      return { outcome: "refused", reason: "provider_reference_conflict" };
    }
    return event.providerObservedAt <= retired.providerObservedAt
      ? { outcome: "ignored" }
      : { outcome: "refused", reason: "moonpay_attempt_revived" };
  }
  if (transfer.provider_reference !== null && transfer.provider_reference !== event.reference) {
    return { outcome: "refused", reason: "provider_reference_conflict" };
  }
  if (
    transfer.provider_reference === event.reference &&
    transfer.provider_observed_at !== null &&
    event.providerObservedAt <= transfer.provider_observed_at
  ) {
    return { outcome: "ignored" };
  }
  return null;
}

async function applyFailedMoonpayBuyObservation(
  repo: PaymentsRepository,
  transfer: PaymentTransferRow,
  event: Extract<MoonpaySettlementEvent, { kind: "failed" }>
): Promise<RampWebhookProcessResult> {
  // A buy card failure can retry before crypto delivery.
  if (
    transfer.status === "settling" ||
    transfer.signature !== null ||
    transfer.submission_started_at !== null ||
    event.onchain?.signature !== undefined ||
    event.settlement?.cryptoTransactionId !== undefined
  ) {
    return { outcome: "refused", reason: "moonpay_failure_after_funding" };
  }
  if (transfer.status !== "expired" && isTerminalRampTransferStatus(transfer.status)) {
    return { outcome: "refused", reason: "moonpay_terminal_conflict" };
  }
  const transitionInput: Parameters<PaymentsRepository["transitionRampTransfer"]>[0] = {
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    transition: "moonpay_attempt_failed",
    updatedAt: new Date().toISOString(),
  };
  if (transfer.provider_reference === event.reference) {
    transitionInput.providerObservation = {
      reference: event.reference,
      observedAt: event.providerObservedAt,
    };
  }
  const updated = await repo.transitionRampTransfer(transitionInput);
  if (!updated) return { outcome: "refused", reason: "moonpay_failure_after_funding" };
  await repo.releaseMoonpayProviderReference({
    transferId: transfer.id,
    providerReference: transfer.provider_reference,
    providerObservedAt:
      transfer.provider_reference === event.reference ? event.providerObservedAt : null,
  });
  const failureInput: Parameters<PaymentsRepository["recordFailedMoonpayTransaction"]>[0] = {
    transactionId: event.reference,
    transferId: transfer.id,
    providerObservedAt: event.providerObservedAt,
  };
  if (event.error) failureInput.failureReason = event.error;
  if (event.settlement) failureInput.settlement = event.settlement;
  await repo.recordFailedMoonpayTransaction(failureInput);
  return { outcome: "applied" };
}

/** Serializes claims, failures, and ordered status writes for one transfer. */
async function processMoonpayObservation(
  env: Env,
  environment: SdpEnvironment,
  event: Exclude<MoonpaySettlementEvent, { kind: "ignore" }>
): Promise<RampWebhookProcessResult> {
  try {
    return await getDb(env).transaction(async (tx) => {
      const client = asTransactionalClient(tx);
      const repo = createSystemTransactionalPaymentsRepository(client);
      const locked = await repo.lockTransferForProvider({
        transferId: event.transferId,
        provider: "moonpay",
      });
      // The same transaction id can target two transfers at once. Hold one
      // database lock through both the live reference claim and failed-id write.
      const ownerTransferId = locked
        ? await repo.lockMoonpayTransactionOwner(event.reference)
        : null;
      const preflight = await moonpayObservationPreflight(
        repo,
        locked,
        environment,
        event,
        ownerTransferId
      );
      if (preflight) return preflight;
      if (!locked) throw new Error("MoonPay preflight accepted a missing transfer");
      const { transfer } = locked;
      if (event.kind === "failed" && transfer.type === "onramp") {
        return applyFailedMoonpayBuyObservation(repo, transfer, event);
      }
      if (transfer.type === "offramp" && transfer.status === "failed") {
        return { outcome: "refused", reason: "moonpay_terminal_conflict" };
      }
      if (
        event.kind === "failed" &&
        !RAMP_TRANSFER_TRANSITIONS.moonpay_sell_failed.from.some(
          (status) => status === transfer.status
        )
      ) {
        // A deposit already claimed may still land. Keep its state for review.
        return { outcome: "refused", reason: "moonpay_sell_failed" };
      }

      if (transfer.status !== "expired" && isTerminalRampTransferStatus(transfer.status)) {
        if (event.kind === "settled" && transfer.status === "canceled") {
          return { outcome: "refused", reason: "settled_after_cancel" };
        }
        return { outcome: "ignored" };
      }
      const claimed = await repo.claimProviderReference({
        provider: "moonpay",
        transferId: event.transferId,
        providerReference: event.reference,
        environment,
        updatedAt: new Date().toISOString(),
      });
      if (!claimed) throw new Error("MoonPay reference claim changed while transfer was locked");
      const result = await applyRampSettlementEvent(env, environment, event, client);
      if (!result.applied) throw new RollBackMoonpayClaim(result);
      // Keep the failed sale for operator review after withdrawing its deposit.
      return event.kind === "failed"
        ? { outcome: "refused", reason: "moonpay_sell_failed" }
        : result;
    });
  } catch (error) {
    if (error instanceof RollBackMoonpayClaim) return error.result;
    if (isPostgresUniqueViolation(error)) {
      return { outcome: "refused", reason: "provider_reference_conflict" };
    }
    throw error;
  }
}

export const moonpayWebhook = {
  provider: "moonpay" as const,
  signature: {
    header: "moonpay-signature-v2",
    encoding: "hex",
    signedPayload: "timestamp-prefixed",
  } as const,

  eventId(): null {
    return null;
  },

  async verify({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<string> {
    const webhookKey = readMoonpayWebhookKey(env, environment);
    const signatureHeader = headers.get("moonpay-signature-v2")?.trim();
    if (!signatureHeader) {
      throw new AppError("UNAUTHORIZED", "MoonPay webhook is missing Moonpay-Signature-V2 header", {
        provider: this.provider,
      });
    }

    const parsed = parseMoonpaySignatureV2Header(signatureHeader);
    if (!parsed) {
      throw new AppError("UNAUTHORIZED", "MoonPay webhook signature header is malformed", {
        provider: this.provider,
      });
    }

    await verifyWebhookSignature({
      provider: this.provider,
      signedPayload: `${parsed.timestamp}.${rawBody}`,
      signature: parsed.signature,
      algorithm: { type: "hmac-sha256", secret: webhookKey, encoding: "hex" },
      timestampSeconds: Number(parsed.timestamp),
    });

    return rawBody;
  },

  parse(rawBody: string): MoonpaySettlementEvent {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody);
    } catch {
      throw badRequest("MoonPay webhook body must be valid JSON", { provider: this.provider });
    }
    const root = readRecord(decoded);
    if (!root) {
      throw badRequest("MoonPay webhook body must be an object", { provider: this.provider });
    }
    const type = readString(root.type);
    if (
      type === "sell_transaction_created" ||
      type === "sell_transaction_updated" ||
      type === "sell_transaction_failed" ||
      type === "sell_transaction_requote_required"
    ) {
      const sellTransactionData = moonpaySellTransactionSchema.safeParse(root.data);
      if (!sellTransactionData.success) {
        throw badRequest(`MoonPay "${type}" webhook carries a malformed sell transaction`, {
          provider: this.provider,
          errors: sellTransactionData.error.issues,
        });
      }
      const soldCrypto = moonpaySoldCryptoSchema.safeParse(root.data);
      if (!soldCrypto.success) {
        throw badRequest(`MoonPay "${type}" webhook carries a malformed baseCurrency`, {
          provider: this.provider,
          errors: soldCrypto.error.issues,
        });
      }
      return withSettledAsset(
        type,
        moonpaySellTransactionSettlementEvent(sellTransactionData.data),
        soldCrypto.data.baseCurrency?.code
      );
    }

    if (
      type !== "transaction_created" &&
      type !== "transaction_updated" &&
      type !== "transaction_failed"
    ) {
      return { provider: "moonpay", kind: "ignore", reason: `unsupported_event:${type}` };
    }

    const transactionData = moonpayBuyTransactionSchema.safeParse(root.data);
    if (!transactionData.success) {
      throw badRequest(`MoonPay "${type}" webhook carries a malformed transaction`, {
        provider: this.provider,
        errors: transactionData.error.issues,
      });
    }
    return withSettledAsset(
      type,
      moonpayTransactionSettlementEvent(transactionData.data),
      transactionData.data.currency?.code
    );
  },

  async process(
    env: Env,
    environment: SdpEnvironment,
    event: MoonpaySettlementEvent
  ): Promise<RampWebhookProcessResult> {
    if (event.kind === "ignore") {
      getLogger().info(`[moonpay webhook] ignored event: ${event.reason}`);
      return { outcome: "ignored" };
    }
    return processMoonpayObservation(env, environment, event);
  },
} satisfies WebhookProcessor<MoonpaySettlementEvent>;
