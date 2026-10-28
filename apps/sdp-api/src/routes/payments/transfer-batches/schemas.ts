import { z } from "zod";
import { paymentAmountSchema, paymentTokenSchema } from "@/routes/payments/schemas";

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
  recipients: z.array(transferBatchRecipientSchema).min(1).max(500),
  options: transferBatchOptionsSchema.optional(),
});

/** A payout run's name (HOO-2335): the run key is derived from it. */
export const transferBatchExternalIdSchema = z.string().min(1).max(256);

/**
 * A batch names its payout run (HOO-2335): the run key that keeps a resend
 * under a new Idempotency-Key from paying anyone twice is derived from it.
 * Required for every new batch, but the schema lets an omitted one through so
 * a same-key retry of a batch created before the field was required still
 * reaches its replay; createTransferBatch refuses any other request without it.
 */
export const createTransferBatchSchema = transferBatchMovementSchema.extend({
  externalId: transferBatchExternalIdSchema.optional(),
});

/** An estimate moves nothing, so it needs no run name; one sent is accepted. */
export const estimateTransferBatchSchema = transferBatchMovementSchema.extend({
  externalId: z.string().min(1).max(256).optional(),
});

export const listTransferBatchesQuerySchema = z.strictObject({
  sourceCustodyWalletId: z.string().min(1).optional(),
  token: z.string().optional(),
  status: transferBatchStatusSchema.optional(),
  externalId: z.string().min(1).max(256).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
