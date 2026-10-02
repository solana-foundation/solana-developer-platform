/**
 * Projects Routes
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  addProjectMember,
  listProjectMembers,
  removeProjectMember,
  updateProjectMember,
} from "./handlers/members";
import { getProject, listProjects, updateProject } from "./handlers/projects";
import { apiKeyProjectAccessMiddleware } from "./project-access";
import { addMemberSchema, updateMemberSchema, updateProjectSchema } from "./schemas";

const projects = new Hono<{ Bindings: Env }>();

// All routes require authentication
projects.use("*", unifiedAuthMiddleware());

// API keys are bound to one project. Apply this at the router boundary so
// every current and future path-scoped project handler inherits the check.
projects.use("/:projectId", apiKeyProjectAccessMiddleware());
projects.use("/:projectId/*", apiKeyProjectAccessMiddleware());

// ═══════════════════════════════════════════════════════════════════════════
// Project CRUD
// ═══════════════════════════════════════════════════════════════════════════

projects.get("/", requirePermissions("projects:read"), listProjects);
projects.get("/:projectId", requirePermissions("projects:read"), getProject);
projects.patch(
  "/:projectId",
  requirePermissions("projects:write"),
  validateBody(updateProjectSchema),
  updateProject
);
// ═══════════════════════════════════════════════════════════════════════════
// Project Members
// ═══════════════════════════════════════════════════════════════════════════

projects.get("/:projectId/members", requirePermissions("project-members:read"), listProjectMembers);
projects.post(
  "/:projectId/members",
  requirePermissions("project-members:write"),
  validateBody(addMemberSchema),
  addProjectMember
);
projects.patch(
  "/:projectId/members/:memberId",
  requirePermissions("project-members:write"),
  validateBody(updateMemberSchema),
  updateProjectMember
);
projects.delete(
  "/:projectId/members/:memberId",
  requirePermissions("project-members:write"),
  removeProjectMember
);

export default projects;
