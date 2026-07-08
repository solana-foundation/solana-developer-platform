import type { SdpEnvironment } from "@sdp/types";
import { AppError, badRequest, providerNotConfigured } from "@/lib/errors";
import type { RampSettlementEvent, RampWebhookValidationContext } from "@/lib/ramps/types";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import type { AppContext, WebhookProcessor } from "./processor";
import { applyRampSettlementEvent } from "./settlements";

interface CoinbaseAmount {
  value: string;
}

const COINBASE_ORDER_STATUS = {
  ONRAMP_ORDER_STATUS_PENDING_AUTH: "settling",
  ONRAMP_ORDER_STATUS_PENDING_PAYMENT: "settling",
  ONRAMP_ORDER_STATUS_PROCESSING: "settling",
  ONRAMP_ORDER_STATUS_COMPLETED: "settled",
  ONRAMP_ORDER_STATUS_FAILED: "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;

function coinbaseSettlementKind(
  eventType: string,
  status: string | undefined
): "settling" | "settled" | "failed" | undefined {
  switch (eventType) {
    case "onramp.transaction.success":
      return "settled";
    case "onramp.transaction.failed":
      return "failed";
    default:
      return status
        ? COINBASE_ORDER_STATUS[status as keyof typeof COINBASE_ORDER_STATUS]
        : undefined;
  }
}

interface CoinbaseWebhookSignatureFields {
  timestamp: string;
  signature: string;
}

/**
 * Parses the comma-separated `t=<timestamp>,v0=<signature>` X-Hook0-Signature header.
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

// TODO(coinbase): type against real onramp.transaction.* samples before production.
interface CoinbaseOnrampWebhookEvent {
  eventType: string;
  data: {
    orderId: string;
    status?: string;
    purchaseAmount?: CoinbaseAmount;
    failureReason?: string;
  };
}

/**
 * Maps a Coinbase onramp webhook payload to a provider-agnostic settlement event.
 */
function parseCoinbaseWebhookEvent(payload: unknown): RampSettlementEvent {
  const { eventType, data } = payload as CoinbaseOnrampWebhookEvent;
  if (!eventType?.startsWith("onramp.transaction.")) {
    return { provider: "coinbase", kind: "ignore", reason: `unsupported_event:${eventType}` };
  }
  if (!data?.orderId) {
    return { provider: "coinbase", kind: "ignore", reason: "missing_order_id" };
  }

  const kind = coinbaseSettlementKind(eventType, data.status);
  if (!kind) {
    return {
      provider: "coinbase",
      kind: "ignore",
      reason: `unhandled:${eventType}:${data.status}`,
    };
  }
  const reference = data.orderId;
  if (kind === "failed") {
    return {
      provider: "coinbase",
      kind,
      reference,
      ...(data.failureReason ? { error: data.failureReason } : {}),
    };
  }
  if (kind === "settled") {
    return {
      provider: "coinbase",
      kind,
      reference,
      ...(data.purchaseAmount ? { receivedAmount: data.purchaseAmount.value } : {}),
    };
  }
  return { provider: "coinbase", kind, reference };
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
