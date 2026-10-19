import { z } from "zod";
import { paymentAmountSchema, solanaAddressSchema } from "@/routes/payments/schemas";

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
});

export const paymentRequestParamsSchema = z.object({
  paymentRequestId: z.string().min(1),
});
