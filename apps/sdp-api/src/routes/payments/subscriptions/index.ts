import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { idempotent } from "@/middleware/idempotency";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  createSubscription,
  getSubscription,
  listSubscriptionCollectionAttempts,
  listSubscriptions,
  prepareCancelSubscription,
  prepareResumeSubscription,
  prepareSubscriptionAuthorization,
  prepareSubscriptionCollection,
} from "./handlers";
import {
  createSubscriptionSchema,
  prepareSubscriptionAuthorizationSchema,
  prepareSubscriptionCollectionSchema,
  prepareSubscriptionLifecycleSchema,
} from "./schemas";

const subscriptions = new Hono<{ Bindings: Env }>();

subscriptions.post(
  "/",
  requirePermissions("payments:write", "counterparties:read"),
  idempotent({ key: "accepted" }),
  validateBody(createSubscriptionSchema),
  createSubscription
);
subscriptions.get("/", requirePermissions("payments:read"), listSubscriptions);
subscriptions.post(
  "/:subscriptionId/prepare-authorization",
  requirePermissions("payments:write", "counterparties:read"),
  idempotent({ key: "accepted" }),
  validateBody(prepareSubscriptionAuthorizationSchema),
  prepareSubscriptionAuthorization
);
subscriptions.post(
  "/:subscriptionId/prepare-cancel",
  requirePermissions("payments:write"),
  idempotent({ key: "accepted" }),
  validateBody(prepareSubscriptionLifecycleSchema),
  prepareCancelSubscription
);
subscriptions.post(
  "/:subscriptionId/prepare-resume",
  requirePermissions("payments:write"),
  idempotent({ key: "accepted" }),
  validateBody(prepareSubscriptionLifecycleSchema),
  prepareResumeSubscription
);
subscriptions.post(
  "/:subscriptionId/prepare-collection",
  requirePermissions("payments:write", "wallets:read"),
  idempotent({ key: "accepted" }),
  validateBody(prepareSubscriptionCollectionSchema),
  prepareSubscriptionCollection
);
subscriptions.get("/:subscriptionId", requirePermissions("payments:read"), getSubscription);
subscriptions.get(
  "/:subscriptionId/collection-attempts",
  requirePermissions("payments:read"),
  listSubscriptionCollectionAttempts
);

export default subscriptions;
