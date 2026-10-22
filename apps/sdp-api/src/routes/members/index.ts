/**
 * Organization Members Routes
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { requireHumanSession } from "@/middleware/human-session";
import { projectContextMiddleware } from "@/middleware/project-context";
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

// Membership is organization-wide, so reads need no project. Mutations keep
// project context because idempotency keys are scoped to a project.
members.get("/", requireAction("members.read"), listMembers);
members.get("/me", requireAction("members.read"), getCurrentMember);
members.post(
  "/invite",
  projectContextMiddleware(),
  requireAction("members.manage"),
  validateBody(inviteSchema),
  inviteMember
);

// Declared before /:memberId so "invitations" and "me" are not read as member ids.
members.delete(
  "/invitations/:invitationId",
  projectContextMiddleware(),
  requireAction("members.manage"),
  revokeInvitation
);
members.delete(
  "/me",
  projectContextMiddleware(),
  publicRoute(
    "signed-in members only: leaving acts on the caller's own membership, which any member may end"
  ),
  leaveOrganization
);
members.patch(
  "/:memberId",
  projectContextMiddleware(),
  requireAction("members.manage"),
  validateBody(updateMemberRoleSchema),
  updateMemberRole
);
members.delete(
  "/:memberId",
  projectContextMiddleware(),
  requireAction("members.manage"),
  removeMember
);
