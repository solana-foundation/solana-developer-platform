import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
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
  updateSubscriptionPlanSchema,
} from "./schemas";

const subscriptionPlans = new Hono<{ Bindings: Env }>();

subscriptionPlans.post(
  "/",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createSubscriptionPlanSchema),
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
  validateBody(updateSubscriptionPlanSchema),
  updateSubscriptionPlan
);

export default subscriptionPlans;
