import { z } from "zod";
import { badRequest } from "@/lib/errors";

const BVNK_POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

const bvnkAmount = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((value) => BVNK_POSITIVE_DECIMAL.test(value), "Expected a positive decimal amount");

export const BVNK_WEBHOOK_ENVELOPE = z.object({ event: z.string().min(1), data: z.unknown() });
export const BVNK_WEBHOOK_DATA = z.record(z.string(), z.unknown());

const bvnkCustomerStatusField = z.object({ status: z.string().min(1) });

export const bvnkCustomersStatusChangeSchema = bvnkCustomerStatusField.extend({
  customerId: z.string().min(1),
});

export const bvnkPlatformCustomerStatusChangeSchema = bvnkCustomerStatusField.extend({
  reference: z.string().min(1),
});

export const bvnkPlatformCustomerUpdateSchema = bvnkCustomerStatusField.extend({
  reference: z.string().min(1),
  externalReference: z.string().min(1),
});

export const bvnkLedgerWalletStatusChangeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  paymentInstruments: z
    .array(
      z.object({
        type: z.string().optional(),
        accountNumber: z.string().optional(),
        remittanceInformationPrefix: z.string().optional(),
        bankDetails: z
          .object({
            bic: z.string().optional(),
            name: z.string().optional(),
          })
          .optional(),
      })
    )
    .optional(),
});

export const bvnkLedgerWalletCreateSchema = z.object({
  walletName: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  ledgers: z
    .array(
      z.object({
        accountNumber: z.string().optional(),
        code: z.string().optional(),
        accountNumberFormat: z.string().optional(),
      })
    )
    .optional(),
});

export type BvnkLedgerWalletStatusChangeData = z.infer<typeof bvnkLedgerWalletStatusChangeSchema>;
export type BvnkLedgerWalletCreateData = z.infer<typeof bvnkLedgerWalletCreateSchema>;

export const bvnkPayinStatusChangeSchema = z.object({
  customerReference: z.string().optional(),
  beneficiary: z.object({ walletId: z.string().optional() }).optional(),
  status: z.string().optional(),
  amount: z.object({ value: bvnkAmount }).optional(),
  uuid: z.string().optional(),
});

export const bvnkChannelTransactionSchema = z.object({
  reference: z.string().optional(),
  channelId: z.string().optional(),
  uuid: z.string().optional(),
  hash: z.string().optional(),
  status: z.string().optional(),
  paidCurrency: z.string().optional(),
  displayCurrency: z.string().optional(),
  walletCurrency: z.string().optional(),
  feeCurrency: z.string().optional(),
  paidAmount: bvnkAmount.optional(),
  displayAmount: bvnkAmount.optional(),
  walletAmount: bvnkAmount.optional(),
  feeAmount: bvnkAmount.optional(),
});

/**
 * Parses a handled event's data object with its per-event schema, rejecting
 * with a joined `path: message` issue list when the data is invalid.
 */
export function parseBvnkWebhookData<S extends z.ZodType>(
  event: string,
  schema: S,
  data: Record<string, unknown>,
  provider: string
): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");
    throw badRequest(`BVNK webhook "${event}" has an invalid data object: ${issues}`, {
      provider,
    });
  }
  return parsed.data;
}
