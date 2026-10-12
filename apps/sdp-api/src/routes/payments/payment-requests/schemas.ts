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

export const createPaymentRequestSchema = z.union([
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
]);

export const listPaymentRequestsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["awaiting_payment", "paid", "canceled", "expired"]).optional(),
});
