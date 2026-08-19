/**
 * Organizations Routes
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  deleteOrganization,
  getOrganization,
  getOrganizationProviderAccess,
  updateOrganization,
} from "./handlers";
import { updateOrgSchema } from "./schemas";

const organizations = new Hono<{ Bindings: Env }>();

// Protected routes below require authentication
organizations.use("/:orgId/*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

organizations.get("/:orgId", requirePermissions("org:read"), getOrganization);
organizations.get(
  "/:orgId/provider-access",
  requirePermissions("org:read"),
  getOrganizationProviderAccess
);
organizations.patch(
  "/:orgId",
  requirePermissions("org:write"),
  validateBody(updateOrgSchema),
  updateOrganization
);
organizations.delete("/:orgId", requirePermissions("org:admin"), deleteOrganization);

export default organizations;
