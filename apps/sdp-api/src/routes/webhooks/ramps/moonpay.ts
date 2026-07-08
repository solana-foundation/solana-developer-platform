import type { MoonpayRampSettlement, SdpEnvironment } from "@sdp/types";
import { AppError, badRequest, providerNotConfigured } from "@/lib/errors";
import { readRecord, readString } from "@/lib/json";
import type { RampSettlementEvent, RampWebhookValidationContext } from "@/lib/ramps/types";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import type { AppContext, WebhookProcessor } from "./processor";
import { applyRampSettlementEvent } from "./settlements";

function readMoonpayWebhookKey(
  env: Record<string, string | undefined>,
  environment: SdpEnvironment
): string {
  const webhookKey = (
    environment === "sandbox" ? env.MOONPAY_SANDBOX_WEBHOOK_KEY : env.MOONPAY_WEBHOOK_KEY
  )?.trim();
  if (!webhookKey) {
    throw providerNotConfigured(
      environment === "sandbox"
        ? "MoonPay sandbox webhook key is not configured (MOONPAY_SANDBOX_WEBHOOK_KEY)."
        : "MoonPay webhook key is not configured (MOONPAY_WEBHOOK_KEY)."
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

const MOONPAY_TRANSACTION_STATUS = {
  waitingPayment: "awaiting_payment",
  pending: "settling",
  waitingAuthorization: "settling",
  completed: "settled",
  failed: "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;
type MoonpayTransactionStatus = keyof typeof MOONPAY_TRANSACTION_STATUS;

interface MoonpayTransactionWebhook {
  type: "transaction_created" | "transaction_updated" | "transaction_failed";
  data: {
    id: string;
    status: MoonpayTransactionStatus;
    externalTransactionId: string | null;
    failureReason: string | null;
    baseCurrencyAmount?: number;
    quoteCurrencyAmount?: number;
    feeAmount?: number;
    extraFeeAmount?: number;
    networkFeeAmount?: number;
    areFeesIncluded?: boolean;
    usdRate?: number;
    cryptoTransactionId?: string | null;
    baseCurrency?: { code: string };
    currency?: { code: string };
  };
}

function buildMoonpaySettlement(
  data: MoonpayTransactionWebhook["data"],
  status: MoonpayRampSettlement["status"]
): MoonpayRampSettlement | undefined {
  const {
    baseCurrency,
    currency,
    baseCurrencyAmount,
    quoteCurrencyAmount,
    feeAmount,
    extraFeeAmount,
    networkFeeAmount,
    areFeesIncluded,
    usdRate,
    cryptoTransactionId,
    failureReason,
  } = data;
  if (
    !baseCurrency ||
    !currency ||
    baseCurrencyAmount === undefined ||
    quoteCurrencyAmount === undefined ||
    feeAmount === undefined ||
    extraFeeAmount === undefined ||
    networkFeeAmount === undefined ||
    areFeesIncluded === undefined ||
    usdRate === undefined
  ) {
    return undefined;
  }
  return {
    provider: "moonpay",
    status,
    baseCurrencyCode: baseCurrency.code.toUpperCase(),
    baseCurrencyAmount,
    quoteCurrencyCode: currency.code.toUpperCase(),
    quoteCurrencyAmount,
    feeAmount,
    extraFeeAmount,
    networkFeeAmount,
    areFeesIncluded,
    usdRate,
    ...(cryptoTransactionId ? { cryptoTransactionId } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
}

export class MoonpayWebhookProcessor implements WebhookProcessor<unknown, RampSettlementEvent> {
  readonly provider = "moonpay";

  async verify({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<unknown> {
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

    try {
      return JSON.parse(rawBody);
    } catch {
      throw badRequest("MoonPay webhook body must be valid JSON", {
        provider: this.provider,
      });
    }
  }

  parse(payload: unknown): RampSettlementEvent {
    const root = readRecord(payload);
    if (!root) {
      throw badRequest("MoonPay webhook body must be an object", { provider: this.provider });
    }
    const type = readString(root.type);
    if (
      type !== "transaction_created" &&
      type !== "transaction_updated" &&
      type !== "transaction_failed"
    ) {
      return { provider: this.provider, kind: "ignore", reason: `unsupported_event:${type}` };
    }

    const transactionData = readRecord(root.data);
    if (!transactionData) {
      throw badRequest(`MoonPay "${type}" webhook is missing transaction data`, {
        provider: this.provider,
      });
    }
    const data = transactionData as MoonpayTransactionWebhook["data"];

    const reference = data.externalTransactionId;
    if (!reference) {
      return { provider: this.provider, kind: "ignore", reason: "missing_external_transaction_id" };
    }

    const kind = MOONPAY_TRANSACTION_STATUS[data.status];
    if (!kind) {
      return {
        provider: this.provider,
        kind: "ignore",
        reason: `unsupported_status:${data.status}`,
      };
    }
    if (kind === "failed") {
      const settlement = buildMoonpaySettlement(data, "failed");
      return {
        provider: this.provider,
        kind,
        reference,
        ...(data.failureReason ? { error: data.failureReason } : {}),
        ...(settlement ? { settlement } : {}),
      };
    }
    if (kind === "settled") {
      const settlement = buildMoonpaySettlement(data, "completed");
      return {
        provider: this.provider,
        kind,
        reference,
        ...(data.quoteCurrencyAmount !== undefined
          ? { receivedAmount: String(data.quoteCurrencyAmount) }
          : {}),
        ...(settlement ? { settlement } : {}),
      };
    }
    return { provider: this.provider, kind, reference };
  }

  async process(c: AppContext, _environment: SdpEnvironment, event: RampSettlementEvent) {
    if (event.kind === "ignore") {
      console.log(`[moonpay webhook] ignored event: ${event.reason}`);
      return;
    }
    await applyRampSettlementEvent(c, event);
  }
}
