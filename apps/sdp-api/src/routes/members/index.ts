/**
 * Organization Members Routes
 */

import { Hono } from "hono";
import { runWithSystemDatabaseIdentity } from "@/db";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  acceptInvitation,
  inviteMember,
  listMembers,
  removeMember,
  revokeInvitation,
} from "./handlers";
import { acceptSchema, inviteSchema } from "./schemas";

const members = new Hono<{ Bindings: Env }>();

// All routes require authentication (API key, session, or Clerk)
members.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
members.use("*", projectContextMiddleware());

members.get("/", requirePermissions("org:read"), listMembers);
members.post("/invite", requirePermissions("org:write"), validateBody(inviteSchema), inviteMember);

// Accept invitation runs behind the shared auth + project-context middleware
// above; it has no permission gate because the invitation token in the body is
// the authorizing credential. It redeems into the invitation's organization —
// not the caller's active one — so it runs under an explicit system database
// identity rather than the request's tenant identity.
members.post("/accept", validateBody(acceptSchema), (c) =>
  runWithSystemDatabaseIdentity("http:invitation-accept", () => acceptInvitation(c))
);

// Declared before /:memberId so "invitations" is not read as a member id.
members.delete("/invitations/:invitationId", requirePermissions("org:write"), revokeInvitation);
members.delete("/:memberId", requirePermissions("org:admin"), removeMember);

export default members;
