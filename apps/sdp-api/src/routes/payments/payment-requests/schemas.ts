import { z } from "zod";
import { paymentAmountSchema, solanaAddressSchema } from "../schemas";

const paymentRequestFields = {
  token: solanaAddressSchema("token"),
  amount: paymentAmountSchema,
  counterpartyId: z.string().min(1).nullable().default(null),
  expiresAt: z.iso.datetime().nullable().default(null),
};

const walletSelectorSchema = z
  .string()
  .min(1)
  .regex(/^\S+$/, "Wallet ID must not contain whitespace");

const paymentRequestTermsSchema = z.object(paymentRequestFields);

// Validate common terms first so selector branching cannot hide their field errors.
export const createPaymentRequestSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    const terms = paymentRequestTermsSchema.safeParse(value);
    if (!terms.success) {
      for (const issue of terms.error.issues) ctx.addIssue({ ...issue });
    }
  })
  .pipe(
    z.union([
      z.strictObject({
        ...paymentRequestFields,
        custodyWalletId: walletSelectorSchema,
        walletId: z.never().optional(),
      }),
      z.strictObject({
        ...paymentRequestFields,
        walletId: walletSelectorSchema,
        custodyWalletId: z.never().optional(),
      }),
    ])
  );

export const listPaymentRequestsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["awaiting_payment", "paid", "canceled", "expired"]).optional(),
});
