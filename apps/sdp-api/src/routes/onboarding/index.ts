/**
 * Onboarding Routes
 */

import type { Env } from "@/types/env";
import { Hono } from "hono";
import { clerkOnboardingMiddleware } from "@/middleware/clerk-onboarding";
import { getOnboardingStatus, linkOrganization } from "./handlers";

const onboarding = new Hono<{ Bindings: Env }>();

onboarding.use("*", clerkOnboardingMiddleware());
onboarding.get("/status", getOnboardingStatus);
onboarding.post("/link-org", linkOrganization);

export default onboarding;
