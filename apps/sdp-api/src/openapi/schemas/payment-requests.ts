import { PAYMENT_REQUEST_STATUSES } from "@sdp/types/payments";
import { SOLANA_CLUSTERS } from "@sdp/types/well-known-tokens";
import { z } from "zod";
import { transactionRequestBodySchema } from "@/routes/pay/schemas";
import {
  createPaymentRequestSchema,
  listPaymentRequestsQuerySchema,
  paymentRequestParamsSchema,
} from "@/routes/payments/payment-requests/schemas";
import {
  base64Schema,
  isoDateTimeSchema,
  solanaAddressSchema,
  walletIdParamSchema,
  withOpenApi,
} from "./base";
import { paymentRequestSchema } from "./payments";

export const paymentRequestPathSchema = paymentRequestParamsSchema;
export const paymentRequestListQuerySchema = listPaymentRequestsQuerySchema;
export const paymentLinkPathSchema = z.object({
  publicToken: z.string().min(1).openapi({
    description: "Bearer token returned by request creation or the manage-level link read.",
  }),
});

export const createPaymentRequestBodySchema = createPaymentRequestSchema.extend({
  walletId: walletIdParamSchema,
  token: withOpenApi(createPaymentRequestSchema.shape.token, {
    description:
      "Solana token mint address for the request. This endpoint requires an address, not a token symbol.",
  }),
  amount: withOpenApi(createPaymentRequestSchema.shape.amount, {
    description: "Positive token amount in UI units as a decimal string.",
  }),
});

export const paymentRequestRecordResponseSchema = paymentRequestSchema;
export const createdPaymentRequestResponseSchema = paymentRequestSchema.extend({
  publicToken: z.string().min(1).openapi({
    description:
      "Bearer credential for the request's /pay link. Share only with the intended payer.",
  }),
});
export const paymentRequestListResponseSchema = z.object({
  paymentRequests: z.array(paymentRequestSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export const paymentRequestLinkResponseSchema = z.object({
  id: z.string(),
  publicToken: z
    .string()
    .min(1)
    .openapi({ description: "Bearer credential for this payment link." }),
});

/** /pay replies are Solana Pay payloads, without the SDP data/meta envelope. */
export const paymentLinkResponseSchema = z.object({
  amount: z.string(),
  token: solanaAddressSchema,
  tokenSymbol: z.string(),
  recipient: solanaAddressSchema,
  reference: solanaAddressSchema,
  status: z.enum(PAYMENT_REQUEST_STATUSES),
  expiresAt: isoDateTimeSchema.nullable(),
  network: z.enum(SOLANA_CLUSTERS),
  solanaPayUrl: z.string().url().nullable(),
});
export const paymentLinkMetadataResponseSchema = z.object({
  label: z.string(),
  icon: z.string().url(),
});
export const preparePaymentLinkBodySchema = withOpenApi(transactionRequestBodySchema, {
  description: "Payer's Solana account. The payer signs the returned transaction client-side.",
});
export const preparedPaymentLinkResponseSchema = z.object({
  transaction: base64Schema,
  message: z.string(),
});
