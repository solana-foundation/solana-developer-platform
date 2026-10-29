/**
 * Onboarding status routes.
 *
 * Organization creation and membership sync are handled exclusively by Clerk
 * webhooks. This route only lets the dashboard inspect whether that sync has
 * completed for the active Clerk organization.
 */

import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { clerkOnboardingMiddleware } from "@/middleware/clerk-onboarding";
import { publicRoute } from "@/middleware/require-action";
import type { Env } from "@/types/env";
import { authorizeOnboardingSession } from "./access";
import { getOnboardingStatus } from "./handlers";

export const onboarding = new Hono<{ Bindings: Env }>();

onboarding.use("*", clerkOnboardingMiddleware());
onboarding.get(
  "/status",
  publicRoute("onboarding: a Clerk session before its organization is provisioned"),
  authorize(authorizeOnboardingSession),
  getOnboardingStatus
);
