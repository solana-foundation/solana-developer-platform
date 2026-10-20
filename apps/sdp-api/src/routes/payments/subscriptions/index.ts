import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import { authorizeSubscriptionCreate } from "@/routes/payments/access";
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

export const subscriptions = new Hono<{ Bindings: Env }>();

subscriptions.post(
  "/",
  requireAction("recurring.manage"),
  validateBody(createSubscriptionSchema),
  authorize(authorizeSubscriptionCreate),
  idempotent({ key: "accepted", serverErrors: "store" }),
  createSubscription
);
subscriptions.get("/", requireAction("recurring.read"), listSubscriptions);
subscriptions.post(
  "/:subscriptionId/prepare-authorization",
  requireAction("recurring.execute"),
  validateBody(prepareSubscriptionAuthorizationSchema),
  prepareSubscriptionAuthorization
);
subscriptions.post(
  "/:subscriptionId/prepare-cancel",
  requireAction("recurring.manage"),
  validateBody(prepareSubscriptionLifecycleSchema),
  prepareCancelSubscription
);
subscriptions.post(
  "/:subscriptionId/prepare-resume",
  requireAction("recurring.execute"),
  validateBody(prepareSubscriptionLifecycleSchema),
  prepareResumeSubscription
);
subscriptions.post(
  "/:subscriptionId/prepare-collection",
  requireAction("recurring.execute"),
  validateBody(prepareSubscriptionCollectionSchema),
  prepareSubscriptionCollection
);
subscriptions.get("/:subscriptionId", requireAction("recurring.read"), getSubscription);
subscriptions.get(
  "/:subscriptionId/collection-attempts",
  requireAction("recurring.read"),
  listSubscriptionCollectionAttempts
);
