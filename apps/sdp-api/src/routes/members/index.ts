/**
 * Organization Members Routes
 */

import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { Hono } from "hono";
import { inviteMember, listMembers, removeMember } from "./handlers";

const members = new Hono<{ Bindings: Env }>();

// All routes require authentication (API key, session, or Clerk)
members.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

members.get("/", requirePermissions("org:read"), listMembers);
members.post("/invite", requirePermissions("org:write"), inviteMember);

members.delete("/:memberId", requirePermissions("org:admin"), removeMember);

export default members;
