/**
 * Onboarding status routes.
 *
 * Organization creation and membership sync are handled exclusively by Clerk
 * webhooks. This route only lets the dashboard inspect whether that sync has
 * completed for the active Clerk organization.
 */

import { Hono } from "hono";
import { clerkOnboardingMiddleware } from "@/middleware/clerk-onboarding";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { completeOnboarding, getOnboardingStatus } from "./handlers";
import { completeOnboardingSchema } from "./schemas";

const onboarding = new Hono<{ Bindings: Env }>();

onboarding.use("*", clerkOnboardingMiddleware());
onboarding.get("/status", getOnboardingStatus);
onboarding.post("/complete", validateBody(completeOnboardingSchema), completeOnboarding);

export default onboarding;
