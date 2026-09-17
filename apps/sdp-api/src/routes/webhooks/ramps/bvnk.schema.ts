import { bvnkV2CustomerStatusSchema } from "@sdp/payments/ramps/providers/bvnk/schemas";
import type { BvnkBankFundingDetails } from "@sdp/types";
import { z } from "zod";

const bvnkAmountSchema = z.union([z.string().min(1), z.number().finite()]).transform(String);

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
    event: z.literal("bvnk:customers:status-change"),
    data: z.object({ customerId: z.string().min(1), status: bvnkV2CustomerStatusSchema }),
  }),
  z.object({
    event: z.literal("bvnk:platform:customer:update"),
    data: z.object({ reference: z.string().min(1) }),
  }),
  z.object({
    event: z.literal("bvnk:customers:agreements:status-change"),
    data: z.object({
      customerId: z.string().min(1),
      agreementId: z.string().min(1),
      status: z.string().min(1),
      respondedAt: z.string().optional(),
    }),
  }),
  z.object({
    event: z.literal("ledger:v2:wallet:status-change"),
    data: z
      .object({
        name: z.string().min(1),
        status: z.string().min(1),
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
    data: z.object({
      status: z.string().min(1),
      customerReference: z.string().min(1),
      beneficiary: z.object({ walletId: z.string().min(1) }),
      amount: z.object({ value: bvnkAmountSchema }),
      uuid: z.string().min(1),
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
