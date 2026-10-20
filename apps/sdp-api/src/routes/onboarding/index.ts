/**
 * Onboarding status routes.
 *
 * Organization creation and membership sync are handled exclusively by Clerk
 * webhooks. This route only lets the dashboard inspect whether that sync has
 * completed for the active Clerk organization.
 */

import { Hono } from "hono";
import { clerkOnboardingMiddleware } from "@/middleware/clerk-onboarding";
import { publicRoute } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { completeOnboarding, getOnboardingStatus } from "./handlers";
import { completeOnboardingSchema } from "./schemas";

export const onboarding = new Hono<{ Bindings: Env }>();

onboarding.use("*", clerkOnboardingMiddleware());
onboarding.get(
  "/status",
  publicRoute("onboarding: a Clerk session before its organization is provisioned"),
  getOnboardingStatus
);
onboarding.post(
  "/complete",
  publicRoute("onboarding: a Clerk session before its organization is provisioned"),
  validateBody(completeOnboardingSchema),
  completeOnboarding
);
