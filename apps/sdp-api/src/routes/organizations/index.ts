/**
 * Organizations Routes
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { requireHumanSession } from "@/middleware/human-session";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  deleteOrganization,
  getOrganization,
  getOrganizationProviderAccess,
  updateOrganization,
} from "./handlers";
import { updateOrgSchema } from "./schemas";

export const organizations = new Hono<{ Bindings: Env }>();

// Protected routes below require authentication
organizations.use("/:orgId/*", unifiedAuthMiddleware());

organizations.get("/:orgId", requireAction("organizations.read"), getOrganization);
organizations.get(
  "/:orgId/provider-access",
  requireAction("organizations.read"),
  getOrganizationProviderAccess
);
// Organization administration (settings, including the IP allowlist, and
// deletion) is for a signed-in person only, never an API key (HOO-2099).
organizations.patch(
  "/:orgId",
  requireHumanSession(),
  requireAction("organizations.manage"),
  validateBody(updateOrgSchema),
  updateOrganization
);
organizations.delete(
  "/:orgId",
  requireHumanSession(),
  requireAction("organizations.manage"),
  deleteOrganization
);
