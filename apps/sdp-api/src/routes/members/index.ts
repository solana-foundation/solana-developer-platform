/**
 * Organization Members Routes
 */

import { authMiddleware, requirePermissions } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { Hono } from "hono";
import { acceptInvitation, inviteMember, listMembers, removeMember } from "./handlers";

const members = new Hono<{ Bindings: Env }>();

// All routes require authentication
members.use("*", authMiddleware());

members.get("/", requirePermissions("org:read"), listMembers);
members.post("/invite", requirePermissions("org:write"), inviteMember);

// Accept invitation does not require auth
members.post("/accept", acceptInvitation);

members.delete("/:memberId", requirePermissions("org:admin"), removeMember);

export default members;
