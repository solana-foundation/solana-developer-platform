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

// Accept invitation does not require auth
members.post("/accept", acceptInvitation);

members.delete("/:memberId", requirePermissions("org:admin"), removeMember);

export default members;
