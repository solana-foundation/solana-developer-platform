import type { MoonpayRampSettlement } from "@sdp/types";
import { z } from "zod";
import { decimalStringFromNumber } from "../../../decimal";
import type { RampOnchainTransfer, RampSettlementEvent } from "../../types";

export type MoonpaySettlementEvent =
  | ({ provider: "moonpay" } & Extract<RampSettlementEvent, { kind: "ignore" }>)
  | ({ provider: "moonpay"; transferId: string } & Exclude<
      RampSettlementEvent,
      { kind: "ignore" }
    >);

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
  walletAddress: z.string().nullish(),
  cryptoTransactionId: z.string().nullish(),
  baseCurrency: z.object({ code: z.string() }).optional(),
  currency: z.object({ code: z.string() }).optional(),
});
export type MoonpayBuyTransactionData = z.infer<typeof moonpayBuyTransactionSchema>;

function moonpayBuyOnchainTransfer(
  data: MoonpayBuyTransactionData
): RampOnchainTransfer | undefined {
  if (!data.cryptoTransactionId) {
    return undefined;
  }
  const onchain: RampOnchainTransfer = { signature: data.cryptoTransactionId };
  if (data.walletAddress) {
    onchain.destinationAddress = data.walletAddress;
  }
  if (data.quoteCurrencyAmount !== undefined) {
    onchain.amount = decimalStringFromNumber(data.quoteCurrencyAmount);
  }
  return onchain;
}

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
): MoonpaySettlementEvent {
  const transferId = data.externalTransactionId;
  if (!transferId) {
    return { provider: "moonpay", kind: "ignore", reason: "missing_external_transaction_id" };
  }
  const onchain = moonpayBuyOnchainTransfer(data);
  const identity: {
    reference: string;
    transferId: string;
    onchain?: RampOnchainTransfer;
  } = { reference: data.id, transferId };
  if (onchain !== undefined) {
    identity.onchain = onchain;
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
      ...identity,
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
      ...identity,
      ...providerCustomer,
      ...(data.quoteCurrencyAmount !== undefined
        ? { receivedAmount: decimalStringFromNumber(data.quoteCurrencyAmount) }
        : {}),
      ...(settlement ? { settlement } : {}),
    };
  }
  return {
    provider: "moonpay",
    kind,
    ...identity,
    ...providerCustomer,
  };
}

const MOONPAY_SELL_TRANSACTION_STATUS = {
  waitingForDeposit: "awaiting_payment",
  requoteRequired: "awaiting_payment",
  pending: "settling",
  completed: "settled",
  failed: "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;

/**
 * One MoonPay Sell transaction as it arrives in `sell_transaction_*` webhook
 * `data`. `status` stays an open string so a status MoonPay ships later maps
 * to an ignore event instead of a parse failure.
 */
export const moonpaySellTransactionSchema = z.object({
  id: z.string(),
  status: z.string(),
  customerId: z.string().optional(),
  externalTransactionId: z.string().nullish(),
  failureReason: z.string().nullish(),
  baseCurrencyAmount: z.number().optional(),
  quoteCurrencyAmount: z.number().optional(),
  refundWalletAddress: z.string().nullish(),
  depositHash: z.string().nullish(),
  depositWallet: z.object({ walletAddress: z.string() }).nullish(),
});
export type MoonpaySellTransactionData = z.infer<typeof moonpaySellTransactionSchema>;

function moonpaySellOnchainTransfer(
  data: MoonpaySellTransactionData
): RampOnchainTransfer | undefined {
  if (!data.depositHash) {
    return undefined;
  }
  const onchain: RampOnchainTransfer = { signature: data.depositHash };
  if (data.refundWalletAddress) {
    onchain.sourceAddress = data.refundWalletAddress;
  }
  if (data.depositWallet) {
    onchain.destinationAddress = data.depositWallet.walletAddress;
  }
  if (data.baseCurrencyAmount !== undefined) {
    onchain.amount = decimalStringFromNumber(data.baseCurrencyAmount);
  }
  return onchain;
}

/**
 * Maps one MoonPay Sell transaction to the provider-agnostic settlement
 * event. While the sale waits for its deposit the event carries the deposit
 * wallet and expected crypto amount, so SDP can send the crypto on the
 * customer's behalf — MoonPay may issue a NEW deposit wallet when the
 * customer re-confirms the sale, so the latest event always wins. A
 * `requoteRequired` sale stays awaiting payment but carries `cryptoDeposit:
 * null`: the pending instruction is withdrawn until the customer accepts the
 * new quote.
 *
 * @param data - The MoonPay sell transaction payload (webhook `data`).
 * @returns The settlement event, or an ignore event for unmatchable payloads.
 */
export function moonpaySellTransactionSettlementEvent(
  data: MoonpaySellTransactionData
): MoonpaySettlementEvent {
  const transferId = data.externalTransactionId;
  if (!transferId) {
    return { provider: "moonpay", kind: "ignore", reason: "missing_external_transaction_id" };
  }
  const onchain = moonpaySellOnchainTransfer(data);
  const identity: {
    reference: string;
    transferId: string;
    onchain?: RampOnchainTransfer;
  } = { reference: data.id, transferId };
  if (onchain !== undefined) {
    identity.onchain = onchain;
  }

  if (!Object.hasOwn(MOONPAY_SELL_TRANSACTION_STATUS, data.status)) {
    return {
      provider: "moonpay",
      kind: "ignore",
      reason: `unsupported_status:${data.status}`,
    };
  }
  const kind =
    MOONPAY_SELL_TRANSACTION_STATUS[data.status as keyof typeof MOONPAY_SELL_TRANSACTION_STATUS];
  const providerCustomer = data.customerId ? { providerCustomerId: data.customerId } : {};
  switch (kind) {
    case "awaiting_payment": {
      if (data.status === "requoteRequired") {
        return {
          provider: "moonpay",
          kind,
          ...identity,
          ...providerCustomer,
          cryptoDeposit: null,
        };
      }
      return {
        provider: "moonpay",
        kind,
        ...identity,
        ...providerCustomer,
        ...(data.depositWallet && data.baseCurrencyAmount !== undefined
          ? {
              cryptoDeposit: {
                destinationAddress: data.depositWallet.walletAddress,
                amount: decimalStringFromNumber(data.baseCurrencyAmount),
              },
            }
          : {}),
      };
    }
    case "settled":
      return {
        provider: "moonpay",
        kind,
        ...identity,
        ...providerCustomer,
        ...(data.quoteCurrencyAmount !== undefined
          ? { receivedAmount: decimalStringFromNumber(data.quoteCurrencyAmount) }
          : {}),
      };
    case "failed":
      return {
        provider: "moonpay",
        kind,
        ...identity,
        ...providerCustomer,
        ...(data.failureReason ? { error: data.failureReason } : {}),
      };
    case "settling":
      return {
        provider: "moonpay",
        kind,
        ...identity,
        ...providerCustomer,
      };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled MoonPay sell settlement kind: ${exhaustive}`);
    }
  }
}
