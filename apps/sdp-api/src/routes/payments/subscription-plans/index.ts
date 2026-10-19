import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { requireAction } from "@/middleware/require-action";
import { validateBody, validateParams } from "@/middleware/validate";
import {
  authorizeSubscriptionPlanCreate,
  authorizeSubscriptionPlanUpdate,
} from "@/routes/payments/access";
import type { Env } from "@/types/env";
import {
  createSubscriptionPlan,
  getSubscriptionPlan,
  listSubscriptionPlans,
  prepareCreateSubscriptionPlan,
  updateSubscriptionPlan,
} from "./handlers";
import {
  createSubscriptionPlanSchema,
  prepareSubscriptionPlanCreateSchema,
  subscriptionPlanIdParamsSchema,
  updateSubscriptionPlanSchema,
} from "./schemas";

export const subscriptionPlans = new Hono<{ Bindings: Env }>();

subscriptionPlans.post(
  "/",
  requireAction("recurring.manage"),
  validateBody(createSubscriptionPlanSchema),
  authorize(authorizeSubscriptionPlanCreate),
  idempotent({ key: "accepted", serverErrors: "store" }),
  createSubscriptionPlan
);
subscriptionPlans.get("/", requireAction("recurring.read"), listSubscriptionPlans);
subscriptionPlans.post(
  "/:planId/prepare-create",
  requireAction("recurring.manage"),
  validateBody(prepareSubscriptionPlanCreateSchema),
  prepareCreateSubscriptionPlan
);
subscriptionPlans.get("/:planId", requireAction("recurring.read"), getSubscriptionPlan);
subscriptionPlans.patch(
  "/:planId",
  requireAction("recurring.execute"),
  validateParams(subscriptionPlanIdParamsSchema),
  validateBody(updateSubscriptionPlanSchema),
  authorize(authorizeSubscriptionPlanUpdate),
  idempotent({ key: "accepted", serverErrors: "store" }),
  updateSubscriptionPlan
);
