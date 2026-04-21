/**
 * Onboarding status routes.
 *
 * Organization creation and membership sync are handled exclusively by Clerk
 * webhooks. This route only lets the dashboard inspect whether that sync has
 * completed for the active Clerk organization.
 */

import { Hono } from "hono";
import { clerkOnboardingMiddleware } from "@/middleware/clerk-onboarding";
import type { Env } from "@/types/env";
import { getOnboardingStatus } from "./handlers";

const onboarding = new Hono<{ Bindings: Env }>();

onboarding.use("*", clerkOnboardingMiddleware());
onboarding.get("/status", getOnboardingStatus);

export default onboarding;
