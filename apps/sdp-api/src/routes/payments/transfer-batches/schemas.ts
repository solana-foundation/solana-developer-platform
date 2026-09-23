import { z } from "zod";
import { paymentAmountSchema, paymentTokenSchema } from "../schemas";

export const priorityFeeSchema = z.enum(["none", "low", "medium", "high", "auto"]);

export const transferBatchIdParamsSchema = z.object({
  batchId: z.string().min(1),
});

export const transferBatchStatusSchema = z.enum([
  "pending",
  "processing",
  "confirmed",
  "failed",
  "partially_failed",
  "archived",
]);

export const transferBatchRecipientStatusSchema = z.enum([
  "pending",
  "processing",
  "confirmed",
  "failed",
  "archived",
]);

export const transferBatchRecipientSchema = z.object({
  externalId: z.string().min(1).max(256).optional(),
  counterpartyId: z.string().min(1).optional(),
  counterpartyAccountId: z.string().min(1),
  amount: paymentAmountSchema,
});

export const transferBatchOptionsSchema = z.object({
  maxRecipientsPerTransaction: z.number().int().min(1).max(64).optional(),
  priorityFee: priorityFeeSchema.optional(),
  preflight: z.boolean().optional(),
});

export const createTransferBatchSchema = z.strictObject({
  projectId: z.string().min(1).optional(),
  externalId: z.string().min(1).max(256).optional(),
  sourceCustodyWalletId: z.string().min(1),
  token: paymentTokenSchema,
  recipients: z.array(transferBatchRecipientSchema).min(1).max(500),
  options: transferBatchOptionsSchema.optional(),
});

export const estimateTransferBatchSchema = createTransferBatchSchema;

export const listTransferBatchesQuerySchema = z.strictObject({
  sourceCustodyWalletId: z.string().min(1).optional(),
  token: z.string().optional(),
  status: transferBatchStatusSchema.optional(),
  externalId: z.string().min(1).max(256).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
