/**
 * Organization Members Routes
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import { acceptInvitation, inviteMember, listMembers, removeMember } from "./handlers";

const members = new Hono<{ Bindings: Env }>();

// All routes require authentication (API key, session, or Clerk)
members.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
members.use("*", projectContextMiddleware());

members.get("/", requirePermissions("org:read"), listMembers);
members.post("/invite", requirePermissions("org:write"), inviteMember);

// Accept invitation runs behind the shared auth + project-context middleware
// above; it has no permission gate because the invitation token in the body is
// the authorizing credential.
members.post("/accept", acceptInvitation);

members.delete("/:memberId", requirePermissions("org:admin"), removeMember);

export default members;
