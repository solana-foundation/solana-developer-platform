import { bvnkCustomerStatusSchema } from "@sdp/payments/ramps/providers/bvnk/schemas";
import type { BvnkBankFundingDetails } from "@sdp/types";
import { z } from "zod";

/** Provider-native pay-in statuses SDP acts on; any other string parses and is ignored. */
export const BVNK_PAYIN_STATUSES = ["COMPLETED"] as const;
export type BvnkPayinStatus = (typeof BVNK_PAYIN_STATUSES)[number];

/** Provider-native crypto payout statuses SDP acts on; any other string parses and is ignored. */
export const BVNK_CRYPTO_PAYOUT_STATUSES = ["PROCESSING", "COMPLETE"] as const;
export type BvnkCryptoPayoutStatus = (typeof BVNK_CRYPTO_PAYOUT_STATUSES)[number];

export const bvnkPayinStatusSchema = z.enum(BVNK_PAYIN_STATUSES);
export const bvnkCryptoPayoutStatusSchema = z.enum(BVNK_CRYPTO_PAYOUT_STATUSES);

/** Whether a parsed pay-in status is one the handler acts on. */
export function isBvnkPayinStatus(value: string): value is BvnkPayinStatus {
  return BVNK_PAYIN_STATUSES.some((candidate) => candidate === value);
}

/** Whether a parsed crypto payout status is one the handler acts on. */
export function isBvnkCryptoPayoutStatus(value: string): value is BvnkCryptoPayoutStatus {
  return BVNK_CRYPTO_PAYOUT_STATUSES.some((candidate) => candidate === value);
}

const bvnkAmountSchema = z.union([z.string().min(1), z.number().finite()]).transform(String);

const bvnkMoneySchema = z.object({
  actual: bvnkAmountSchema,
  amount: bvnkAmountSchema,
  currency: z.string().min(1),
});

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
    if (!fiat?.accountNumber) return undefined;
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
    if (!ledger?.accountNumber) return undefined;
    return {
      accountNumber: ledger.accountNumber,
      code: ledger.code,
      accountNumberFormat: ledger.accountNumberFormat,
    };
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
    event: z.literal("payment:v2:payin:status-change"),
    data: bvnkPayinDataSchema,
  }),
  z.object({
    event: z.literal("bvnk:payment:crypto:status-change"),
    data: z.object({
      type: z.string().min(1),
      uuid: z.string().min(1),
      status: z.string().min(1),
      walletId: z.string().min(1),
      reference: z.string().nullable(),
      address: z.object({ address: z.string().min(1), network: z.string().min(1) }).nullable(),
      paidCurrency: bvnkMoneySchema,
      walletCurrency: bvnkMoneySchema,
      feeCurrency: bvnkMoneySchema,
      exchangeRate: z.object({
        base: z.string().min(1),
        rate: z.number(),
        counter: z.string().min(1),
      }),
      transactions: z.array(z.object({ hash: z.string().min(1) })),
    }),
  }),
  z.object({
    event: z.literal("bvnk:payment:channel:transaction-detected"),
    data: z.object({ reference: z.string().optional() }),
  }),
  z.object({
    event: z.literal("bvnk:payment:channel:transaction-confirmed"),
    data: z.object({ reference: z.string().optional(), walletAmount: bvnkAmountSchema }),
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
