import { readRecord, readString } from "@sdp/payments/json";
import type { RampSettlementEvent, RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { CoinbaseRampSettlement, SdpEnvironment } from "@sdp/types";
import { z } from "zod";
import { AppError, badRequest, providerNotConfigured } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import type { AppContext, WebhookProcessor } from "./processor";
import { applyRampSettlementEvent } from "./settlements";

const COINBASE_ORDER_STATUS = {
  ONRAMP_ORDER_STATUS_PENDING_PAYMENT: "awaiting_payment",
  ONRAMP_ORDER_STATUS_PENDING_AUTH: "settling",
  ONRAMP_ORDER_STATUS_PROCESSING: "settling",
  ONRAMP_ORDER_STATUS_COMPLETED: "settled",
  ONRAMP_ORDER_STATUS_FAILED: "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;
type CoinbaseOrderStatus = keyof typeof COINBASE_ORDER_STATUS;

const coinbaseOnrampOrderSnapshot = z.object({
  orderId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  destinationAddress: z.string(),
  destinationNetwork: z.string(),
  partnerUserRef: z.string(),
  paymentMethod: z.string(),
  paymentCurrency: z.string(),
  paymentSubtotal: z.string(),
  paymentTotal: z.string(),
  purchaseCurrency: z.string(),
  purchaseAmount: z.string(),
  exchangeRate: z.string(),
  fees: z.array(z.object({ feeAmount: z.string(), feeCurrency: z.string(), feeType: z.string() })),
  failureReason: z.string().optional(),
});

const coinbaseOnrampWebhookSchema = z.discriminatedUnion("eventType", [
  coinbaseOnrampOrderSnapshot.extend({ eventType: z.literal("onramp.transaction.created") }),
  coinbaseOnrampOrderSnapshot.extend({ eventType: z.literal("onramp.transaction.updated") }),
  coinbaseOnrampOrderSnapshot.extend({
    eventType: z.literal("onramp.transaction.success"),
    txHash: z.string().optional(),
  }),
  coinbaseOnrampOrderSnapshot.extend({ eventType: z.literal("onramp.transaction.failed") }),
]);
type CoinbaseOnrampOrderEvent = z.infer<typeof coinbaseOnrampWebhookSchema>;
type CoinbaseOnrampEventType = CoinbaseOnrampOrderEvent["eventType"];

const COINBASE_ONRAMP_EVENT_TYPES = coinbaseOnrampWebhookSchema.options.map(
  (option) => option.shape.eventType.value
);

function isCoinbaseOnrampEventType(value: string): value is CoinbaseOnrampEventType {
  return (COINBASE_ONRAMP_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Resolves the settlement kind: terminal event types are authoritative,
 * lifecycle events defer to the order status.
 */
function coinbaseSettlementKind(
  event: CoinbaseOnrampOrderEvent
): (typeof COINBASE_ORDER_STATUS)[CoinbaseOrderStatus] | undefined {
  switch (event.eventType) {
    case "onramp.transaction.success":
      return "settled";
    case "onramp.transaction.failed":
      return "failed";
    case "onramp.transaction.created":
    case "onramp.transaction.updated":
      return COINBASE_ORDER_STATUS[event.status as CoinbaseOrderStatus];
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * Captures the order economics verbatim from a terminal event.
 */
function buildCoinbaseSettlement(
  event: CoinbaseOnrampOrderEvent,
  status: CoinbaseRampSettlement["status"]
): CoinbaseRampSettlement {
  return {
    provider: "coinbase",
    status,
    paymentCurrency: event.paymentCurrency,
    paymentSubtotal: event.paymentSubtotal,
    paymentTotal: event.paymentTotal,
    purchaseCurrency: event.purchaseCurrency,
    purchaseAmount: event.purchaseAmount,
    exchangeRate: event.exchangeRate,
    fees: event.fees,
    ...(event.eventType === "onramp.transaction.success" && event.txHash
      ? { txHash: event.txHash }
      : {}),
    ...(event.failureReason ? { failureReason: event.failureReason } : {}),
  };
}

/**
 * Maps a Coinbase onramp webhook payload to a provider-agnostic settlement event.
 */
function parseCoinbaseWebhookEvent(payload: unknown): RampSettlementEvent {
  const eventType = readString(readRecord(payload)?.eventType);
  if (eventType !== undefined && !isCoinbaseOnrampEventType(eventType)) {
    return { provider: "coinbase", kind: "ignore", reason: `unsupported_event:${eventType}` };
  }

  const parsed = coinbaseOnrampWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    throw badRequest("Coinbase webhook payload violates the onramp event envelope", {
      provider: "coinbase",
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }
  const event = parsed.data;

  const kind = coinbaseSettlementKind(event);
  if (!kind) {
    return {
      provider: "coinbase",
      kind: "ignore",
      reason: `unhandled:${event.eventType}:${event.status}`,
    };
  }
  if (kind === "failed") {
    return {
      provider: "coinbase",
      kind,
      reference: event.orderId,
      ...(event.failureReason ? { error: event.failureReason } : {}),
      settlement: buildCoinbaseSettlement(event, "failed"),
    };
  }
  if (kind === "settled") {
    return {
      provider: "coinbase",
      kind,
      reference: event.orderId,
      receivedAmount: event.purchaseAmount,
      settlement: buildCoinbaseSettlement(event, "completed"),
    };
  }
  return { provider: "coinbase", kind, reference: event.orderId };
}

interface CoinbaseWebhookSignatureFields {
  timestamp: string;
  signature: string;
}

/**
 * Parses the comma-separated `t=<timestamp>,v0=<signature>,...` X-Hook0-Signature header.
 */
function parseCoinbaseSignatureHeader(header: string): CoinbaseWebhookSignatureFields | undefined {
  const fields = new Map(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
    })
  );
  const timestamp = fields.get("t");
  const signature = fields.get("v0");
  if (!timestamp || !signature) {
    return undefined;
  }
  return { timestamp, signature };
}

export class CoinbaseWebhookProcessor implements WebhookProcessor<unknown, RampSettlementEvent> {
  readonly provider = "coinbase";

  async verify({ env, headers, rawBody }: RampWebhookValidationContext): Promise<unknown> {
    const webhookSecret = env.COINBASE_CDP_RAMPS_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      throw providerNotConfigured(
        "Coinbase webhook secret is not configured (COINBASE_CDP_RAMPS_WEBHOOK_SECRET)."
      );
    }

    const signatureHeader = headers.get("x-hook0-signature")?.trim();
    if (!signatureHeader) {
      throw new AppError("UNAUTHORIZED", "Coinbase webhook is missing X-Hook0-Signature header", {
        provider: this.provider,
      });
    }

    const parsed = parseCoinbaseSignatureHeader(signatureHeader);
    if (!parsed) {
      throw new AppError("UNAUTHORIZED", "Coinbase webhook signature header is malformed", {
        provider: this.provider,
      });
    }

    await verifyWebhookSignature({
      provider: this.provider,
      signedPayload: `${parsed.timestamp}.${rawBody}`,
      signature: parsed.signature,
      algorithm: {
        type: "hmac-sha256",
        secret: webhookSecret,
        encoding: "hex",
      },
      timestampSeconds: Number(parsed.timestamp),
    });

    try {
      return JSON.parse(rawBody);
    } catch {
      throw badRequest("Coinbase webhook body must be valid JSON", { provider: this.provider });
    }
  }

  parse(payload: unknown): RampSettlementEvent {
    return parseCoinbaseWebhookEvent(payload);
  }

  async process(c: AppContext, _environment: SdpEnvironment, event: RampSettlementEvent) {
    if (event.kind === "ignore") {
      console.log(`[coinbase webhook] ignored event: ${event.reason}`);
      return;
    }
    await applyRampSettlementEvent(c, event);
  }
}
