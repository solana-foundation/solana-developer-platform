/**
 * Organization Members Routes
 */

import { Hono } from "hono";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { requireHumanSession } from "@/middleware/human-session";
import { projectContextMiddleware } from "@/middleware/project-context";
import { publicRoute, requireAction } from "@/middleware/require-action";
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

export const members = new Hono<{ Bindings: Env }>();

// All routes require authentication by a signed-in person: an API key cannot
// list, invite, accept for, or remove members (HOO-2099).
members.use("*", unifiedAuthMiddleware());
members.use("*", requireHumanSession());
members.use("*", projectContextMiddleware());

members.get("/", requireAction("members.read"), listMembers);
members.post("/invite", requireAction("members.manage"), validateBody(inviteSchema), inviteMember);

// Accept invitation runs behind the shared auth + project-context middleware
// above; it has no permission gate because the invitation token in the body is
// the authorizing credential. It redeems into the invitation's organization —
// not the caller's active one — so it runs under an explicit system database
// identity rather than the request's tenant identity.
members.post(
  "/accept",
  publicRoute(
    "invitation accept: the invitation token authorizes a signed-in invitee who is not a member yet"
  ),
  validateBody(acceptSchema),
  (c) => runWithSystemDatabaseIdentity("http:invitation-accept", () => acceptInvitation(c))
);

// Declared before /:memberId so "invitations" is not read as a member id.
members.delete("/invitations/:invitationId", requireAction("members.manage"), revokeInvitation);
members.delete("/:memberId", requireAction("members.manage"), removeMember);
