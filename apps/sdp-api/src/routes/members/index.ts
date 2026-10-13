/**
 * Organization Members Routes
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { inviteMember, listMembers, removeMember, revokeInvitation } from "./handlers";
import { inviteSchema } from "./schemas";

const members = new Hono<{ Bindings: Env }>();

// All routes require authentication (API key or Clerk)
members.use("*", unifiedAuthMiddleware());
members.use("*", projectContextMiddleware());

members.get("/", requirePermissions("org:read"), listMembers);
members.post("/invite", requirePermissions("org:write"), validateBody(inviteSchema), inviteMember);

// Declared before /:memberId so "invitations" is not read as a member id.
members.delete("/invitations/:invitationId", requirePermissions("org:write"), revokeInvitation);
members.delete("/:memberId", requirePermissions("org:admin"), removeMember);

export default members;
