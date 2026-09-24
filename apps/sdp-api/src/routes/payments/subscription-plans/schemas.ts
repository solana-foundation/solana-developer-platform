import { PAYMENT_SUBSCRIPTION_PLAN_STATUSES } from "@sdp/types";
import { z } from "zod";
import {
  paymentAmountSchema,
  paymentTokenSchema,
  solanaAddressSchema,
  u64StringSchema,
} from "../schemas";

export const subscriptionPlanIdParamsSchema = z.object({
  planId: z.string().min(1),
});

export const paymentSubscriptionPlanStatusSchema = z.enum(PAYMENT_SUBSCRIPTION_PLAN_STATUSES);

export const createSubscriptionPlanSchema = z.object({
  ownerWalletId: z.string().min(1),
  token: paymentTokenSchema,
  amount: paymentAmountSchema,
  periodHours: z
    .number()
    .int()
    .positive()
    .max(24 * 365),
  programPlanId: u64StringSchema.optional(),
  planPda: solanaAddressSchema("planPda").optional(),
  destinationAddress: solanaAddressSchema("destinationAddress").optional(),
  pullerWalletId: z.string().min(1).optional(),
  metadataUri: z
    .string()
    .url({ protocol: /^https?$/ })
    .max(128)
    .optional(),
  status: paymentSubscriptionPlanStatusSchema.default("draft"),
});

export const updateSubscriptionPlanSchema = z
  .object({
    planPda: solanaAddressSchema("planPda").nullable().optional(),
    destinationAddress: solanaAddressSchema("destinationAddress").nullable().optional(),
    pullerWalletId: z.string().min(1).nullable().optional(),
    metadataUri: z
      .string()
      .url({ protocol: /^https?$/ })
      .max(128)
      .nullable()
      .optional(),
    status: paymentSubscriptionPlanStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const prepareSubscriptionPlanCreateSchema = z.object({
  destinations: z.array(solanaAddressSchema("destinations entry")).max(4).optional(),
  pullers: z.array(solanaAddressSchema("pullers entry")).max(4).optional(),
  endTs: u64StringSchema.optional(),
  metadataUri: z
    .string()
    .url({ protocol: /^https?$/ })
    .max(128)
    .optional(),
});

export const listSubscriptionPlansQuerySchema = z.object({
  status: paymentSubscriptionPlanStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
