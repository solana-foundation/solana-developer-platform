import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { validateBody, validateParams } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { authorizeSubscriptionPlanCreate, authorizeSubscriptionPlanUpdate } from "../access";
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

const subscriptionPlans = new Hono<{ Bindings: Env }>();

subscriptionPlans.post(
  "/",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createSubscriptionPlanSchema),
  authorize(authorizeSubscriptionPlanCreate),
  idempotent({ key: "accepted", serverErrors: "store" }),
  createSubscriptionPlan
);
subscriptionPlans.get("/", requirePermissions("payments:read"), listSubscriptionPlans);
subscriptionPlans.post(
  "/:planId/prepare-create",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(prepareSubscriptionPlanCreateSchema),
  prepareCreateSubscriptionPlan
);
subscriptionPlans.get("/:planId", requirePermissions("payments:read"), getSubscriptionPlan);
subscriptionPlans.patch(
  "/:planId",
  requirePermissions("payments:write", "wallets:read"),
  validateParams(subscriptionPlanIdParamsSchema),
  validateBody(updateSubscriptionPlanSchema),
  authorize(authorizeSubscriptionPlanUpdate),
  idempotent({ key: "accepted", serverErrors: "store" }),
  updateSubscriptionPlan
);

export default subscriptionPlans;
