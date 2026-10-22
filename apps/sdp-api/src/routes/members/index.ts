/**
 * Organization Members Routes
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { requireHumanSession } from "@/middleware/human-session";
import { publicRoute, requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  getCurrentMember,
  inviteMember,
  leaveOrganization,
  listMembers,
  removeMember,
  revokeInvitation,
  updateMemberRole,
} from "./handlers";
import { inviteSchema, updateMemberRoleSchema } from "./schemas";

export const members = new Hono<{ Bindings: Env }>();

// All routes require authentication by a signed-in person: an API key cannot
// list, invite, or remove members (HOO-2099).
members.use("*", unifiedAuthMiddleware());
members.use("*", requireHumanSession());

// Membership reads, role changes and exits act on the organization, even when
// an existing member no longer has access to any project.
members.get("/", requireAction("members.read"), listMembers);
members.get("/me", requireAction("members.read"), getCurrentMember);
members.post("/invite", requireAction("members.manage"), validateBody(inviteSchema), inviteMember);

// Declared before /:memberId so "invitations" and "me" are not read as member ids.
members.delete("/invitations/:invitationId", requireAction("members.manage"), revokeInvitation);
members.delete(
  "/me",
  publicRoute(
    "signed-in members only: leaving acts on the caller's own membership, which any member may end"
  ),
  leaveOrganization
);
members.patch(
  "/:memberId",
  requireAction("members.manage"),
  validateBody(updateMemberRoleSchema),
  updateMemberRole
);
members.delete("/:memberId", requireAction("members.manage"), removeMember);
