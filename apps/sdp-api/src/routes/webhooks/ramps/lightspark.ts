import type { LightsparkGridAmount, LightsparkRampSettlement, SdpEnvironment } from "@sdp/types";
import { formatDecimalAmount } from "@/lib/amount";
import { AppError, badRequest } from "@/lib/errors";
import { readNumber, readRecord, readString } from "@/lib/json";
import { requireEnv } from "@/lib/ramps/shared";
import type { RampSettlementEvent, RampWebhookValidationContext } from "@/lib/ramps/types";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import type { AppContext, WebhookProcessor } from "./processor";
import { applyRampSettlementEvent } from "./settlements";

const LIGHTSPARK_OUTGOING_PAYMENT_WEBHOOK_TYPES = {
  "OUTGOING_PAYMENT.PENDING": "awaiting_payment",
  "OUTGOING_PAYMENT.PROCESSING": "settling",
  "OUTGOING_PAYMENT.COMPLETED": "settled",
  "OUTGOING_PAYMENT.FAILED": "failed",
  "OUTGOING_PAYMENT.EXPIRED": "expired",
  "OUTGOING_PAYMENT.REFUND_FAILED": "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;

type LightsparkOutgoingPaymentWebhookType = keyof typeof LIGHTSPARK_OUTGOING_PAYMENT_WEBHOOK_TYPES;

interface LightsparkOutgoingPaymentData {
  id: string;
  status: string;
  quoteId: string;
  failureReason?: string;
  sentAmount?: LightsparkGridAmount;
  receivedAmount?: LightsparkGridAmount;
  exchangeRate?: number;
  fees?: number;
}

interface LightsparkOutgoingPaymentWebhook {
  type: LightsparkOutgoingPaymentWebhookType;
  data: LightsparkOutgoingPaymentData;
}

/** Thin wrapper over `readString` that fails loudly instead of returning `undefined` for a required field. */
function requireGridString(value: unknown, message: string): string {
  const parsed = readString(value);
  if (!parsed) {
    throw badRequest(message);
  }
  return parsed;
}

/** Thin wrapper over `readRecord` that fails loudly instead of returning `undefined` for a required object. */
function requireGridRecord(value: unknown, message: string): Record<string, unknown> {
  const parsed = readRecord(value);
  if (!parsed) {
    throw badRequest(message);
  }
  return parsed;
}

function readOptionalGridAmount(
  record: Record<string, unknown>,
  field: string
): LightsparkGridAmount | undefined {
  const value = readRecord(record[field]);
  if (!value) {
    return undefined;
  }
  const amount = readNumber(value.amount);
  const currency = readRecord(value.currency);
  if (amount === undefined || !Number.isInteger(amount) || !currency) {
    return undefined;
  }
  const decimals = readNumber(currency.decimals);
  const currencyCode = readString(currency.code);
  if (decimals === undefined || !Number.isInteger(decimals) || !currencyCode) {
    return undefined;
  }
  return { amount, currencyCode: currencyCode.toUpperCase(), decimals };
}

function isLightsparkTerminalStatus(status: string): status is LightsparkRampSettlement["status"] {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "EXPIRED" ||
    status === "REFUND_FAILED"
  );
}

function buildLightsparkSettlement(
  data: LightsparkOutgoingPaymentData
): LightsparkRampSettlement | undefined {
  const { status, sentAmount, receivedAmount, exchangeRate, fees, failureReason } = data;
  if (
    !isLightsparkTerminalStatus(status) ||
    !sentAmount ||
    !receivedAmount ||
    exchangeRate === undefined ||
    fees === undefined
  ) {
    return undefined;
  }
  return {
    provider: "lightspark",
    status,
    sentAmount,
    receivedAmount,
    exchangeRate,
    fees,
    ...(failureReason ? { failureReason } : {}),
  };
}

function isLightsparkOutgoingPaymentWebhookType(
  value: string
): value is LightsparkOutgoingPaymentWebhookType {
  return Object.hasOwn(LIGHTSPARK_OUTGOING_PAYMENT_WEBHOOK_TYPES, value);
}

function parseLightsparkOutgoingPaymentWebhook(
  payload: unknown
): LightsparkOutgoingPaymentWebhook | null {
  const root = requireGridRecord(payload, "Lightspark webhook body must be an object");

  const type = requireGridString(root.type, "Lightspark webhook is missing type");
  if (!isLightsparkOutgoingPaymentWebhookType(type)) {
    return null;
  }

  const data = requireGridRecord(root.data, "Lightspark webhook is missing data");
  return {
    type,
    data: {
      id: requireGridString(data.id, "Lightspark outgoing payment webhook data is missing id"),
      status: requireGridString(
        data.status,
        "Lightspark outgoing payment webhook data is missing status"
      ),
      quoteId: requireGridString(
        data.quoteId,
        "Lightspark outgoing payment webhook data is missing quoteId"
      ),
      failureReason: readString(data.failureReason),
      sentAmount: readOptionalGridAmount(data, "sentAmount"),
      receivedAmount: readOptionalGridAmount(data, "receivedAmount"),
      exchangeRate: readNumber(data.exchangeRate),
      fees: readNumber(data.fees),
    },
  };
}

export class LightsparkWebhookProcessor implements WebhookProcessor<unknown, RampSettlementEvent> {
  readonly provider = "lightspark";

  /**
   * Verifies a Grid webhook via the `X-Grid-Signature` header: an ECDSA P-256 /
   * SHA-256 signature over the raw request body, checked against the Grid
   * webhook public key (PEM/SPKI). The header is JSON `{"v":1,"s":"<base64>"}`.
   */
  async verify({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<unknown> {
    const publicKey = requireEnv(
      env,
      environment === "sandbox"
        ? "LIGHTSPARK_GRID_SANDBOX_WEBHOOK_PUBLIC_KEY"
        : "LIGHTSPARK_GRID_WEBHOOK_PUBLIC_KEY"
    );

    const signatureHeader = headers.get("x-grid-signature")?.trim();
    if (!signatureHeader) {
      throw new AppError("UNAUTHORIZED", "Lightspark webhook is missing x-grid-signature", {
        provider: this.provider,
      });
    }

    let signatureB64 = signatureHeader;
    try {
      const parsed = JSON.parse(signatureHeader) as { s?: unknown };
      if (parsed && typeof parsed.s === "string") {
        signatureB64 = parsed.s;
      }
    } catch {
      // Not JSON. Treat the header value as bare base64.
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw badRequest("Lightspark webhook body must be valid JSON", {
        provider: this.provider,
      });
    }

    const timestamp = payload.timestamp;
    await verifyWebhookSignature({
      provider: this.provider,
      signedPayload: rawBody,
      signature: signatureB64,
      algorithm: { type: "ecdsa-sha256", publicKeyPem: publicKey, encoding: "base64" },
      timestampSeconds: typeof timestamp === "string" ? Date.parse(timestamp) / 1000 : Number.NaN,
    });

    return payload;
  }

  parse(payload: unknown): RampSettlementEvent {
    const webhook = parseLightsparkOutgoingPaymentWebhook(payload);
    if (!webhook) {
      return { provider: this.provider, kind: "ignore", reason: "unsupported_event" };
    }

    const reference = webhook.data.quoteId;
    const kind = LIGHTSPARK_OUTGOING_PAYMENT_WEBHOOK_TYPES[webhook.type];
    const settlement = buildLightsparkSettlement(webhook.data);
    if (kind === "failed" || kind === "expired") {
      return {
        provider: this.provider,
        kind,
        reference,
        ...(webhook.data.failureReason ? { error: webhook.data.failureReason } : {}),
        ...(settlement ? { settlement } : {}),
      };
    }
    if (kind === "settled" && webhook.data.receivedAmount) {
      return {
        provider: this.provider,
        kind,
        reference,
        receivedAmount: formatDecimalAmount(
          BigInt(webhook.data.receivedAmount.amount),
          webhook.data.receivedAmount.decimals
        ),
        ...(settlement ? { settlement } : {}),
      };
    }
    return { provider: this.provider, kind, reference };
  }

  async process(c: AppContext, _environment: SdpEnvironment, event: RampSettlementEvent) {
    if (event.kind === "ignore") {
      console.log(`[lightspark webhook] ignored event: ${event.reason}`);
      return;
    }
    await applyRampSettlementEvent(c, event);
  }
}
