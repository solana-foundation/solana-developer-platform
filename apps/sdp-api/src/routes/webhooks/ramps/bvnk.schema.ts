import { isBvnkPayoutCompleted } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { bvnkCustomerStatusSchema } from "@sdp/payments/ramps/providers/bvnk/schemas";
import type { BvnkBankFundingDetails } from "@sdp/types";
import { z } from "zod";

/**
 * The completed/failed payout status vocabulary is declared once in the
 * packages provider-data module (the observation builders that classify
 * events live beside it) and surfaced here, the schema file every webhook
 * consumer imports from.
 */
export {
  BVNK_CRYPTO_PAYOUT_COMPLETED_STATUSES,
  BVNK_CRYPTO_PAYOUT_FAILED_STATUSES,
  type BvnkCryptoPayoutCompletedStatus,
  type BvnkCryptoPayoutFailedStatus,
  isBvnkPayoutCompleted,
  isBvnkPayoutFailed,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";

/** Provider-native pay-in statuses SDP acts on; any other string parses and is ignored. */
export const BVNK_PAYIN_STATUSES = ["COMPLETED"] as const;
export type BvnkPayinStatus = (typeof BVNK_PAYIN_STATUSES)[number];

/** Provider-native crypto payout statuses SDP acts on; any other string parses and is ignored. */
export const BVNK_CRYPTO_PAYOUT_STATUSES = [
  "PROCESSING",
  "COMPLETE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type BvnkCryptoPayoutStatus = (typeof BVNK_CRYPTO_PAYOUT_STATUSES)[number];

/** Whether a parsed pay-in status is one the handler acts on. */
export function isBvnkPayinStatus(value: string): value is BvnkPayinStatus {
  return BVNK_PAYIN_STATUSES.some((candidate) => candidate === value);
}

/** Whether a parsed crypto payout status is one the handler acts on. */
export function isBvnkCryptoPayoutStatus(value: string): value is BvnkCryptoPayoutStatus {
  return BVNK_CRYPTO_PAYOUT_STATUSES.some((candidate) => candidate === value);
}

/**
 * Decimal-safe amount codec for every money field on the BVNK wire. Strings
 * must be decimal (no sign, no exponent); finite numbers pass only when their
 * canonical string form is also a plain decimal, so `-1` and `1e-7` are
 * rejected HERE, at the boundary, never later. Zero-valued legs (unpaid
 * amounts at create, fees) are legitimate observations.
 */
const bvnkDecimalStringSchema = z
  .string()
  .regex(/^[0-9]+(\.[0-9]+)?$/, "amount must be a decimal string");
const bvnkDecimalNumberSchema = z
  .number()
  .refine(
    (value) => Number.isFinite(value) && value >= 0 && /^[0-9]+(\.[0-9]+)?$/.test(String(value)),
    "amount must be a non-negative decimal number"
  );
const bvnkAmountSchema = z
  .union([bvnkDecimalStringSchema, bvnkDecimalNumberSchema])
  .transform(String);

const bvnkMoneySchema = z.object({
  actual: bvnkAmountSchema,
  amount: bvnkAmountSchema,
  currency: z.string().min(1),
});

/** The legacy v2 pay-in status-change data, retained verbatim so the event parses and is acknowledged-ignored. */
const bvnkPayinDataSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  beneficiary: z.object({
    amount: bvnkAmountSchema,
    currency: z.string().min(1),
    walletId: z.string().min(1),
    customerId: z.string().min(1),
  }),
});

/** The live v1 pay-in status-change data (Zach, Sep 18): only the fields SDP reads to attribute and apply a pay-in. */
const bvnkV1PayinDataSchema = z.object({
  amount: z.object({
    value: bvnkAmountSchema,
    currencyCode: z.string().min(1),
  }),
  status: z.string().min(1),
  metadata: z
    .object({
      additionalRemittanceInformation: z.string().optional(),
    })
    .optional(),
  beneficiary: z.object({
    walletId: z.string().min(1),
  }),
  paymentReference: z.string().min(1),
  customerReference: z.string().min(1),
  transactionReference: z.string().min(1),
});

const bvnkCryptoPayoutDataSchema = z
  .object({
    type: z.string().min(1),
    uuid: z.string().min(1),
    status: z.string().min(1),
    walletId: z.string().min(1),
    reference: z.string().nullable(),
    address: z
      .object({ address: z.string().min(1), network: z.string().min(1) })
      .nullable()
      .optional(),
    paidCurrency: bvnkMoneySchema,
    walletCurrency: bvnkMoneySchema,
    feeCurrency: bvnkMoneySchema,
    networkFeeCurrency: bvnkMoneySchema,
    exchangeRate: z.object({
      base: z.string().min(1),
      rate: z.number().finite(),
      counter: z.string().min(1),
    }),
    transactions: z.array(z.object({ hash: z.string().min(1) })).optional(),
  })
  .superRefine((data, ctx) => {
    if (!isBvnkPayoutCompleted(data.status)) {
      return;
    }
    if (data.transactions === undefined || data.transactions.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["transactions"],
        message: "BVNK payout COMPLETE must carry at least one transaction with a hash",
      });
    }
    if (data.address === null || data.address === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: "BVNK payout COMPLETE must carry the destination address",
      });
    }
  });

const bvnkFiatInstrumentsSchema = z
  .array(
    z.object({
      type: z.string(),
      accountNumber: z.string().optional(),
      remittanceInformationPrefix: z.string().optional(),
      bankDetails: z.object({ bic: z.string().optional(), name: z.string().optional() }).optional(),
    })
  )
  .transform((instruments): BvnkBankFundingDetails | undefined => {
    const fiat = instruments.find((instrument) => instrument.type === "FIAT");
    if (!fiat?.accountNumber) {
      return undefined;
    }
    return {
      accountNumber: fiat.accountNumber,
      code: fiat.bankDetails?.bic,
      paymentReference: fiat.remittanceInformationPrefix,
      bankName: fiat.bankDetails?.name,
    };
  });

const bvnkLedgersSchema = z
  .array(
    z.object({
      accountNumber: z.string().optional(),
      code: z.string().optional(),
      accountNumberFormat: z.string().optional(),
    })
  )
  .transform((ledgers): BvnkBankFundingDetails | undefined => {
    const ledger = ledgers.find((entry) => entry.accountNumber);
    if (!ledger?.accountNumber) {
      return undefined;
    }
    return {
      accountNumber: ledger.accountNumber,
      code: ledger.code,
      accountNumberFormat: ledger.accountNumberFormat,
    };
  });

/**
 * Confirmed channel-transaction data, shaped exactly by the observed payload
 * as `BVNK_CHANNEL_TRANSACTION_CONFIRMED_WEBHOOK` in `@sdp/payments/ramps/providers/bvnk/test-fixtures`:
 * 10 USDC paid in, 9.9 USD credited to the funding wallet, 0.09 USD fee,
 * 0.99 exchange rate, 0.00001 SOL network fee. Every money field is a
 * decimal string on the parsed event; unknown keys are allowed and dropped,
 * matching the crypto payout schema convention.
 */
const bvnkChannelTransactionConfirmedDataSchema = z.object({
  channelId: z.string().min(1),
  walletId: z.string().min(1),
  reference: z.string().min(1),
  uuid: z.string().min(1),
  hash: z.string().min(1),
  address: z.string().min(1),
  paidCurrency: z.string().min(1),
  displayCurrency: z.string().min(1),
  walletCurrency: z.string().min(1),
  feeCurrency: z.string().min(1),
  paidAmount: bvnkAmountSchema,
  displayAmount: bvnkAmountSchema,
  walletAmount: bvnkAmountSchema,
  feeAmount: bvnkAmountSchema,
  exchangeRate: z.object({ rate: bvnkAmountSchema }),
  networkFee: z.object({ paidCurrency: z.string().min(1), paidAmount: bvnkAmountSchema }),
  sources: z.array(z.string().min(1)),
  embeddedCustomerDetails: z.object({ reference: z.string().min(1) }),
});

export const bvnkWebhookSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("bvnk:platform:customer:update"),
    data: z.object({ reference: z.string().min(1) }),
  }),
  z.object({
    event: z.literal("bvnk:platform:customer:status-change"),
    eventId: z.string().min(1),
    timestamp: z.string().datetime(),
    data: z.object({ status: bvnkCustomerStatusSchema, reference: z.string().min(1) }),
  }),
  z.object({
    event: z.literal("bvnk:platform:customer:agreement-session-status-change"),
    eventId: z.string().min(1),
    timestamp: z.string().datetime(),
    data: z.object({ status: z.string().min(1), reference: z.string().min(1) }),
  }),
  z.object({
    event: z.literal("ledger:v2:wallet:status-change"),
    data: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        status: z.string().min(1),
        customer: z.object({ id: z.string().min(1) }).optional(),
        paymentInstruments: bvnkFiatInstrumentsSchema.optional(),
      })
      .transform(({ paymentInstruments, ...wallet }) => ({
        ...wallet,
        bankAccount: paymentInstruments,
      })),
  }),
  z.object({
    event: z.literal("bvnk:ledger:wallet:create"),
    data: z
      .object({
        walletName: z.string().min(1),
        status: z.string().min(1).optional(),
        ledgers: bvnkLedgersSchema.optional(),
      })
      .transform(({ walletName, ledgers, status }) => ({
        name: walletName,
        status,
        bankAccount: ledgers,
      })),
  }),
  z.object({
    event: z.literal("bvnk:payment:payin:status-change"),
    eventId: z.string().min(1),
    timestamp: z.string().datetime(),
    data: bvnkV1PayinDataSchema,
  }),
  z.object({
    event: z.literal("payment:v2:payin:status-change"),
    data: bvnkPayinDataSchema,
  }),
  z.object({
    event: z.literal("bvnk:payment:crypto:status-change"),
    data: bvnkCryptoPayoutDataSchema,
  }),
  z.object({
    event: z.literal("bvnk:payment:channel:transaction-detected"),
    data: z.object({ reference: z.string().optional() }),
  }),
  z.object({
    event: z.literal("bvnk:payment:channel:transaction-confirmed"),
    data: bvnkChannelTransactionConfirmedDataSchema,
  }),
]);

export type BvnkWebhook = z.infer<typeof bvnkWebhookSchema>;

export type BvnkWalletWebhookData = Extract<
  BvnkWebhook,
  { event: "ledger:v2:wallet:status-change" | "bvnk:ledger:wallet:create" }
>["data"];

/** The event names SDP handles; anything else is acknowledged and ignored. */
export const bvnkWebhookEventSchema = z.enum(
  bvnkWebhookSchema.options.map((option) => option.shape.event.value)
);
export type BvnkWebhookEvent = z.infer<typeof bvnkWebhookEventSchema>;

/** Routes a payload to its event before the per-event shape is validated. */
export const bvnkWebhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  data: z.unknown().optional(),
});
