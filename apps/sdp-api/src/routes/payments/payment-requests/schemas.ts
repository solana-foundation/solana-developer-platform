import { z } from "zod";
import { paymentAmountSchema, solanaAddressSchema } from "../schemas";

export const createPaymentRequestSchema = z.object({
  walletId: z.string().min(1),
  token: solanaAddressSchema("token"),
  amount: paymentAmountSchema,
  counterpartyId: z.string().min(1).nullable().default(null),
  expiresAt: z.iso.datetime().nullable().default(null),
});

export const listPaymentRequestsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["awaiting_payment", "paid", "canceled", "expired"]).optional(),
  // A blank or whitespace-only value is an absent filter, not a search for "".
  search: z
    .string()
    .trim()
    .max(200)
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional(),
});

export const paymentRequestIdParamsSchema = z.object({
  requestId: z.string().min(1),
});
