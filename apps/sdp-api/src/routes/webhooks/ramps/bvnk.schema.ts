import { z } from "zod";

const bvnkAmountSchema = z.union([z.string().min(1), z.number().finite()]).transform(String);

/** LedgerWalletV2Response payment instruments; extras are tolerated, not modeled. */
const bvnkFiatInstrumentsSchema = z.array(
  z.object({
    type: z.string(),
    accountHolderName: z.string().optional(),
    accountNumber: z.string().optional(),
    remittanceInformationPrefix: z.string().optional(),
    bankDetails: z
      .object({
        name: z.string().optional(),
        bic: z.string().optional(),
        nid: z.object({ value: z.string(), type: z.string().optional() }).optional(),
      })
      .optional(),
  })
);

export const bvnkWebhookSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("ledger:v2:wallet:status-change"),
    data: z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      paymentInstruments: bvnkFiatInstrumentsSchema.optional(),
    }),
  }),
  z.object({
    event: z.literal("bvnk:ledger:wallet:create"),
    data: z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      paymentInstruments: bvnkFiatInstrumentsSchema.optional(),
    }),
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
    event: z.literal("bvnk:payment:crypto:status-change"),
    data: z.object({
      status: z.string().min(1),
      type: z.string().min(1),
      uuid: z.string().min(1),
      walletId: z.string().min(1),
      reference: z.string().optional(),
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
