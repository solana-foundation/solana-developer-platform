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
import type { SdpEnvironment } from "@sdp/types";
import { z } from "zod";
import { createSystemPaymentsRepository } from "@/db/repositories";
import { AppError, badRequest, providerNotConfigured } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { getLogger } from "@/runtime/logger";
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

  async process(env: Env, _environment: SdpEnvironment, event: MoonpaySettlementEvent) {
    if (event.kind === "ignore") {
      getLogger().info(`[moonpay webhook] ignored event: ${event.reason}`);
      return "ignored" as const;
    }
    const transfer = await createSystemPaymentsRepository(env).setProviderReferenceIfEmpty({
      provider: event.provider,
      transferId: event.transferId,
      providerReference: event.reference,
      updatedAt: new Date().toISOString(),
    });
    if (!transfer) {
      getLogger().warn(
        `[moonpay webhook] refused provider reference for transfer ${event.transferId}`
      );
      return "unmatched" as const;
    }
    return (await applyRampSettlementEvent(env, event)).outcome;
  },
} satisfies WebhookProcessor<MoonpaySettlementEvent>;
