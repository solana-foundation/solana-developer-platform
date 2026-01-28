/**
 * Organizations Routes
 */

import { authMiddleware, requirePermissions } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { Hono } from "hono";
import {
  createOrganization,
  deleteOrganization,
  getOrganization,
  updateOrganization,
} from "./handlers";

const organizations = new Hono<{ Bindings: Env }>();

// Create org (public)
organizations.post("/", createOrganization);

// Protected routes below require authentication
organizations.use("/:orgId/*", authMiddleware());

organizations.get("/:orgId", requirePermissions("org:read"), getOrganization);
organizations.patch("/:orgId", requirePermissions("org:write"), updateOrganization);
organizations.delete("/:orgId", requirePermissions("org:admin"), deleteOrganization);

export default organizations;
