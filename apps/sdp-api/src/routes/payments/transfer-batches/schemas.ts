import { z } from "zod";
import { paymentAmountSchema, paymentTokenSchema } from "@/routes/payments/schemas";

/** The most recipients one batch holds; retry reads a whole batch at this size. */
export const MAX_TRANSFER_BATCH_RECIPIENTS = 500;

const priorityFeeSchema = z.enum(["none", "low", "medium", "high", "auto"]);

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

const transferBatchRecipientSchema = z.object({
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

const transferBatchMovementSchema = z.strictObject({
  projectId: z.string().min(1).optional(),
  sourceCustodyWalletId: z.string().min(1),
  token: paymentTokenSchema,
  recipients: z.array(transferBatchRecipientSchema).min(1).max(MAX_TRANSFER_BATCH_RECIPIENTS),
  options: transferBatchOptionsSchema.optional(),
});

/**
 * A batch names its payout run (HOO-2335): the run key that keeps a resend
 * under a new Idempotency-Key from paying anyone twice is derived from it.
 */
export const createTransferBatchSchema = transferBatchMovementSchema.extend({
  externalId: z.string().min(1).max(256),
});

/** An estimate moves nothing, so it needs no run name; one sent is accepted. */
export const estimateTransferBatchSchema = transferBatchMovementSchema.extend({
  externalId: z.string().min(1).max(256).optional(),
});

/** A retry names its batch in the path and carries no body. */
export const retryTransferBatchSchema = z.strictObject({});

export const listTransferBatchesQuerySchema = z.strictObject({
  sourceCustodyWalletId: z.string().min(1).optional(),
  token: z.string().optional(),
  status: transferBatchStatusSchema.optional(),
  externalId: z.string().min(1).max(256).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
