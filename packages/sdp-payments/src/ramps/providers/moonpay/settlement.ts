import type { MoonpayRampSettlement } from "@sdp/types";
import { z } from "zod";
import type { RampSettlementEvent } from "../../types";

const MOONPAY_TRANSACTION_STATUS = {
  waitingPayment: "awaiting_payment",
  pending: "settling",
  waitingAuthorization: "settling",
  completed: "settled",
  failed: "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;

/**
 * One MoonPay Buy transaction — the same shape arrives as webhook `data` and
 * as an entry of GET /v1/transactions. `status` stays an open string so a
 * status MoonPay ships later maps to an ignore event instead of a parse
 * failure.
 */
export const moonpayBuyTransactionSchema = z.object({
  id: z.string(),
  status: z.string(),
  customerId: z.string().optional(),
  externalTransactionId: z.string().nullish(),
  failureReason: z.string().nullish(),
  createdAt: z.string().optional(),
  baseCurrencyAmount: z.number().optional(),
  quoteCurrencyAmount: z.number().optional(),
  feeAmount: z.number().optional(),
  extraFeeAmount: z.number().optional(),
  networkFeeAmount: z.number().optional(),
  areFeesIncluded: z.boolean().optional(),
  usdRate: z.number().optional(),
  cryptoTransactionId: z.string().nullish(),
  baseCurrency: z.object({ code: z.string() }).optional(),
  currency: z.object({ code: z.string() }).optional(),
});
export type MoonpayBuyTransactionData = z.infer<typeof moonpayBuyTransactionSchema>;

/** The economics fields a terminal MoonPay transaction must carry to record a settlement. */
const moonpaySettlementEconomicsSchema = z.object({
  baseCurrency: z.object({ code: z.string() }),
  currency: z.object({ code: z.string() }),
  baseCurrencyAmount: z.number(),
  quoteCurrencyAmount: z.number(),
  feeAmount: z.number(),
  extraFeeAmount: z.number(),
  networkFeeAmount: z.number(),
  areFeesIncluded: z.boolean(),
  usdRate: z.number(),
  cryptoTransactionId: z.string().nullish(),
  failureReason: z.string().nullish(),
});

/**
 * Captures the provider-reported economics from a terminal MoonPay
 * transaction, verbatim.
 *
 * @param data - The MoonPay transaction payload.
 * @param status - The terminal settlement status the economics belong to.
 * @returns The settlement record, or undefined when the payload omits any economics field.
 */
function buildMoonpaySettlement(
  data: MoonpayBuyTransactionData,
  status: MoonpayRampSettlement["status"]
): MoonpayRampSettlement | undefined {
  const economics = moonpaySettlementEconomicsSchema.safeParse(data);
  if (!economics.success) {
    return undefined;
  }
  const { cryptoTransactionId, failureReason, ...amounts } = economics.data;
  return {
    provider: "moonpay",
    status,
    transactionId: data.id,
    baseCurrencyCode: amounts.baseCurrency.code.toUpperCase(),
    baseCurrencyAmount: amounts.baseCurrencyAmount,
    quoteCurrencyCode: amounts.currency.code.toUpperCase(),
    quoteCurrencyAmount: amounts.quoteCurrencyAmount,
    feeAmount: amounts.feeAmount,
    extraFeeAmount: amounts.extraFeeAmount,
    networkFeeAmount: amounts.networkFeeAmount,
    areFeesIncluded: amounts.areFeesIncluded,
    usdRate: amounts.usdRate,
    ...(cryptoTransactionId ? { cryptoTransactionId } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
}

/**
 * Maps one MoonPay transaction to the provider-agnostic settlement event, the
 * single mapping used by both the webhook processor and the reconciliation
 * cron so the two delivery paths cannot diverge.
 *
 * @param data - The MoonPay transaction payload (webhook `data` or API transaction object).
 * @returns The settlement event, or an ignore event for unmatchable payloads.
 */
export function moonpayTransactionSettlementEvent(
  data: MoonpayBuyTransactionData
): RampSettlementEvent {
  const reference = data.externalTransactionId;
  if (!reference) {
    return { provider: "moonpay", kind: "ignore", reason: "missing_external_transaction_id" };
  }

  if (!Object.hasOwn(MOONPAY_TRANSACTION_STATUS, data.status)) {
    return {
      provider: "moonpay",
      kind: "ignore",
      reason: `unsupported_status:${data.status}`,
    };
  }
  const kind = MOONPAY_TRANSACTION_STATUS[data.status as keyof typeof MOONPAY_TRANSACTION_STATUS];
  const providerCustomer = data.customerId ? { providerCustomerId: data.customerId } : {};
  if (kind === "failed") {
    const settlement = buildMoonpaySettlement(data, "failed");
    return {
      provider: "moonpay",
      kind,
      reference,
      ...providerCustomer,
      ...(data.failureReason ? { error: data.failureReason } : {}),
      ...(settlement ? { settlement } : {}),
    };
  }
  if (kind === "settled") {
    const settlement = buildMoonpaySettlement(data, "completed");
    return {
      provider: "moonpay",
      kind,
      reference,
      ...providerCustomer,
      ...(data.quoteCurrencyAmount !== undefined
        ? { receivedAmount: String(data.quoteCurrencyAmount) }
        : {}),
      ...(settlement ? { settlement } : {}),
    };
  }
  return { provider: "moonpay", kind, reference, ...providerCustomer };
}
