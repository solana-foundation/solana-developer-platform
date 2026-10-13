import { PAYMENT_REQUEST_STATUSES } from "@sdp/types";
import { z } from "zod";
import { paymentAmountSchema, solanaAddressSchema } from "../schemas";

export const createPaymentRequestSchema = z.strictObject({
  custodyWalletId: z.string().min(1).regex(/^\S+$/, "Wallet ID must not contain whitespace"),
  token: solanaAddressSchema("token"),
  amount: paymentAmountSchema,
  counterpartyId: z.string().min(1).nullable().default(null),
  expiresAt: z.iso.datetime().nullable().default(null),
});

export const listPaymentRequestsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(PAYMENT_REQUEST_STATUSES).optional(),
});
