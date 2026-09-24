import { PAYMENT_RECURRING_PAYMENT_STATUSES } from "@sdp/types";
import { z } from "zod";
import { paymentAmountSchema, paymentTokenSchema, recurringTimestampSchema } from "../schemas";

const futureRecurringTimestampSchema = (fieldName: string) =>
  recurringTimestampSchema.refine((value) => new Date(value).getTime() > Date.now(), {
    message: `${fieldName} must be in the future`,
  });
const firstCollectionAtTimestampSchema = futureRecurringTimestampSchema("firstCollectionAt");

export const recurringPaymentIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const paymentRecurringPaymentStatusSchema = z.enum(PAYMENT_RECURRING_PAYMENT_STATUSES);

export const createRecurringPaymentSchema = z.strictObject({
  sourceCustodyWalletId: z.string().min(1),
  counterpartyId: z.string().min(1),
  counterpartyAccountId: z.string().min(1),
  token: paymentTokenSchema,
  amount: paymentAmountSchema,
  periodHours: z
    .number()
    .int()
    .positive()
    .max(24 * 365),
  firstCollectionAt: firstCollectionAtTimestampSchema.optional(),
  metadataUri: z
    .string()
    .url({ protocol: /^https?$/ })
    .max(128)
    .optional(),
});

export const updateRecurringPaymentSchema = z
  .strictObject({
    sourceCustodyWalletId: z.string().min(1).optional(),
    counterpartyId: z.string().min(1).optional(),
    counterpartyAccountId: z.string().min(1).optional(),
    token: paymentTokenSchema.optional(),
    amount: paymentAmountSchema.optional(),
    periodHours: z
      .number()
      .int()
      .positive()
      .max(24 * 365)
      .optional(),
    firstCollectionAt: firstCollectionAtTimestampSchema.nullable().optional(),
    nextCollectionDueAt: recurringTimestampSchema.nullable().optional(),
    metadataUri: z
      .string()
      .url({ protocol: /^https?$/ })
      .max(128)
      .nullable()
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  })
  .refine((value) => !value.counterpartyId || value.counterpartyAccountId, {
    message: "counterpartyAccountId is required when counterpartyId changes",
    path: ["counterpartyAccountId"],
  });

export const activateRecurringPaymentSchema = z.object({}).strict();
export const cancelRecurringPaymentSchema = z.object({}).strict();
export const collectRecurringPaymentSchema = z.object({}).strict();
export const resumeRecurringPaymentSchema = z.object({}).strict();

export const listRecurringPaymentsQuerySchema = z.object({
  counterpartyId: z.string().min(1).optional(),
  status: paymentRecurringPaymentStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
