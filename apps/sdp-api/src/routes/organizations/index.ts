/**
 * Organizations Routes
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { clerkSignupSessionMiddleware } from "@/middleware/clerk-auth";
import { requireHumanSession } from "@/middleware/human-session";
import { publicRoute, requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { createOrganization } from "./create";
import { getOrganization, getOrganizationProviderAccess, updateOrganization } from "./handlers";
import { getMainnetAccess, requestMainnetAccess } from "./mainnet-access";
import { createOrganizationSchema, requestMainnetAccessSchema, updateOrgSchema } from "./schemas";

export const organizations = new Hono<{ Bindings: Env }>();

// A new person has no organization, so the member middleware would refuse
// them; this is the one route a verified Clerk session with none may call.
organizations.post(
  "/",
  clerkSignupSessionMiddleware(),
  publicRoute(
    "signed-in people with no organization: creates the caller's own organization, one per person"
  ),
  validateBody(createOrganizationSchema),
  createOrganization
);

// Protected routes below require authentication
organizations.use("/:orgId/*", unifiedAuthMiddleware());

organizations.get("/:orgId", requireAction("organizations.read"), getOrganization);
organizations.get(
  "/:orgId/provider-access",
  requireAction("organizations.read"),
  getOrganizationProviderAccess
);
// Organization administration (settings, including the IP allowlist) is for a
// signed-in person only, never an API key (HOO-2099).
organizations.patch(
  "/:orgId",
  requireHumanSession(),
  requireAction("organizations.manage"),
  validateBody(updateOrgSchema),
  updateOrganization
);

// Mainnet access (HOO-2427) is asked for from the dashboard's organization
// settings: an admin's own act, binding the organization to the Terms and
// Conditions, so never an API key. Only admins see the settings card, so its
// read is administration too.
organizations.get(
  "/:orgId/mainnet-access",
  requireHumanSession(),
  requireAction("organizations.manage"),
  getMainnetAccess
);
organizations.post(
  "/:orgId/mainnet-access",
  requireHumanSession(),
  requireAction("organizations.manage"),
  validateBody(requestMainnetAccessSchema),
  requestMainnetAccess
);
