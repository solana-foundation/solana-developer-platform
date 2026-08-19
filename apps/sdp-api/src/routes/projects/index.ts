/**
 * Projects Routes
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
import { apiKeyCreateSchema } from "@/routes/api-keys/schemas";
import type { Env } from "@/types/env";
import { createProjectApiKey, listProjectApiKeys } from "./handlers/api-keys";
import {
  addProjectMember,
  listProjectMembers,
  removeProjectMember,
  updateProjectMember,
} from "./handlers/members";
import { archiveProject, getProject, listProjects, updateProject } from "./handlers/projects";
import { apiKeyProjectAccessMiddleware } from "./project-access";
import { addMemberSchema, updateMemberSchema, updateProjectSchema } from "./schemas";

const projects = new Hono<{ Bindings: Env }>();

// All routes require authentication
projects.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

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
projects.delete("/:projectId", requirePermissions("projects:admin"), archiveProject);

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

// ═══════════════════════════════════════════════════════════════════════════
// Project API Keys
// ═══════════════════════════════════════════════════════════════════════════

projects.get("/:projectId/api-keys", requirePermissions("api-keys:read"), listProjectApiKeys);
projects.post(
  "/:projectId/api-keys",
  requirePermissions("api-keys:write"),
  validateBody(apiKeyCreateSchema),
  createProjectApiKey
);

export default projects;
