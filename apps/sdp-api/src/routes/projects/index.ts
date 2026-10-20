/**
 * Projects Routes
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { requireHumanSession } from "@/middleware/human-session";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
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
import { getProject, listProjects, updateProject } from "./handlers/projects";
import { apiKeyProjectAccessMiddleware } from "./project-access";
import { projectProviderAvailability } from "./provider-availability";
import { addMemberSchema, updateMemberSchema, updateProjectSchema } from "./schemas";

export const projects = new Hono<{ Bindings: Env }>();

// All routes require authentication
projects.use("*", unifiedAuthMiddleware());
// Project members and API keys are managed by a signed-in person only, never
// an API key (HOO-2099).
for (const humanOnly of [
  "/:projectId/members",
  "/:projectId/members/*",
  "/:projectId/api-keys",
  "/:projectId/api-keys/*",
]) {
  projects.use(humanOnly, requireHumanSession());
}

// API keys are bound to one project. Apply this at the router boundary so
// every current and future path-scoped project handler inherits the check.
projects.use("/:projectId", apiKeyProjectAccessMiddleware());
projects.use("/:projectId/*", apiKeyProjectAccessMiddleware());
// A production project is refused without the organization's production
// entitlement, like every other project-scoped route (APE-351): minting a
// production key or wallet here must not outrun that gate.
const pathProjectContext = projectContextMiddleware({ projectIdParam: "projectId" });
projects.use("/:projectId", pathProjectContext);
projects.use("/:projectId/*", pathProjectContext);

// ═══════════════════════════════════════════════════════════════════════════
// Project CRUD
// ═══════════════════════════════════════════════════════════════════════════

projects.get("/", requireAction("projects.read"), listProjects);
projects.get("/:projectId", requireAction("projects.read"), getProject);
projects.patch(
  "/:projectId",
  requireAction("projects.manage"),
  validateBody(updateProjectSchema),
  updateProject
);
// ═══════════════════════════════════════════════════════════════════════════
// Project Members
// ═══════════════════════════════════════════════════════════════════════════

projects.get("/:projectId/members", requireAction("members.read"), listProjectMembers);
projects.post(
  "/:projectId/members",
  requireAction("members.manage"),
  validateBody(addMemberSchema),
  addProjectMember
);
projects.patch(
  "/:projectId/members/:memberId",
  requireAction("members.manage"),
  validateBody(updateMemberSchema),
  updateProjectMember
);
projects.delete(
  "/:projectId/members/:memberId",
  requireAction("members.manage"),
  removeProjectMember
);

// ═══════════════════════════════════════════════════════════════════════════
// Project API Keys
// ═══════════════════════════════════════════════════════════════════════════

projects.get("/:projectId/api-keys", requireAction("api_keys.read"), listProjectApiKeys);
projects.post(
  "/:projectId/api-keys",
  requireAction("api_keys.manage"),
  validateBody(apiKeyCreateSchema),
  createProjectApiKey
);

// ═══════════════════════════════════════════════════════════════════════════
// Project Provider Availability
// ═══════════════════════════════════════════════════════════════════════════

projects.route("/:projectId/provider-availability", projectProviderAvailability);
