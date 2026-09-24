import {
  PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES,
  PAYMENT_SUBSCRIPTION_STATUSES,
} from "@sdp/types";
import { z } from "zod";
import {
  i64StringSchema,
  recurringTimestampSchema,
  solanaAddressSchema,
  u64StringSchema,
} from "../schemas";

export const subscriptionIdParamsSchema = z.object({
  subscriptionId: z.string().min(1),
});

export const paymentSubscriptionStatusSchema = z.enum(PAYMENT_SUBSCRIPTION_STATUSES);

export const paymentSubscriptionCollectionAttemptStatusSchema = z.enum(
  PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES
);

export const createSubscriptionSchema = z
  .object({
    planId: z.string().min(1),
    counterpartyId: z.string().min(1),
    subscriberAddress: solanaAddressSchema("subscriberAddress"),
  })
  .strict();

export const prepareSubscriptionAuthorizationSchema = z.object({
  subscriberTokenAccount: solanaAddressSchema("subscriberTokenAccount"),
  expectedPlanCreatedAt: u64StringSchema,
  expectedSubscriptionAuthorityInitId: i64StringSchema,
});

export const prepareSubscriptionLifecycleSchema = z.object({});

export const listSubscriptionsQuerySchema = z.object({
  planId: z.string().min(1).optional(),
  counterpartyId: z.string().min(1).optional(),
  status: paymentSubscriptionStatusSchema.optional(),
  dueBefore: recurringTimestampSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const prepareSubscriptionCollectionSchema = z
  .object({
    receiverTokenAccount: solanaAddressSchema("receiverTokenAccount"),
  })
  .strict();

export const listSubscriptionCollectionAttemptsQuerySchema = z.object({
  status: paymentSubscriptionCollectionAttemptStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
