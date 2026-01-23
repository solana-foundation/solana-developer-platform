/**
 * Organization Members Routes
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "@/types/env";
import type { OrganizationRole } from "@sdp/types";
import { authMiddleware, requirePermissions } from "@/middleware/auth";
import { success, created, noContent } from "@/lib/response";
import { AppError, notFound } from "@/lib/errors";
import {
  generateInvitationId,
  generateInvitationToken,
  generateUserId,
  generateMemberId,
  hashString,
} from "@/lib/crypto";
import { AuditService } from "@/services/audit.service";

const members = new Hono<{ Bindings: Env }>();

// All routes require authentication
members.use("*", authMiddleware());

// Validation schemas
const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "developer", "viewer"]),
});

const acceptSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
});

/**
 * List organization members
 * GET /v1/members
 */
members.get("/", requirePermissions("org:read"), async (c) => {
  const auth = c.get("apiKey");
  const orgId = auth!.organizationId;

  const results = await c.env.DB.prepare(
    `SELECT om.id, om.role, om.status, om.created_at,
            u.id as user_id, u.email, u.name
     FROM organization_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.organization_id = ? AND om.status = 'active'
     ORDER BY om.created_at ASC`
  )
    .bind(orgId)
    .all();

  const memberList = results.results.map((row) => ({
    id: row.id as string,
    role: row.role as OrganizationRole,
    status: row.status as string,
    createdAt: row.created_at as string,
    user: {
      id: row.user_id as string,
      email: row.email as string,
      name: row.name as string | null,
    },
  }));

  return success(c, { members: memberList });
});

/**
 * Invite a member to the organization
 * POST /v1/members/invite
 */
members.post("/invite", requirePermissions("org:write"), async (c) => {
  const auth = c.get("apiKey");
  const orgId = auth!.organizationId;

  const body = await c.req.json();
  const parsed = inviteSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { email, role } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  // Check if user already exists and is a member
  const existingMember = await c.env.DB.prepare(
    `SELECT om.id FROM organization_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.organization_id = ? AND u.email = ? AND om.status = 'active'`
  )
    .bind(orgId, normalizedEmail)
    .first();

  if (existingMember) {
    throw new AppError("CONFLICT", "User is already a member of this organization");
  }

  // Check for pending invitation
  const existingInvite = await c.env.DB.prepare(
    `SELECT id FROM invitations
     WHERE organization_id = ? AND email = ? AND status = 'pending'`
  )
    .bind(orgId, normalizedEmail)
    .first();

  if (existingInvite) {
    throw new AppError("CONFLICT", "Invitation already sent to this email");
  }

  // Get inviter user ID
  const inviterKey = await c.env.DB.prepare("SELECT created_by FROM api_keys WHERE id = ?")
    .bind(auth!.id)
    .first<{ created_by: string }>();

  // Create invitation
  const invitationId = generateInvitationId();
  const token = generateInvitationToken();
  const tokenHash = await hashString(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  await c.env.DB.prepare(
    `INSERT INTO invitations (id, organization_id, email, role, invited_by, token_hash, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(
      invitationId,
      orgId,
      normalizedEmail,
      role,
      inviterKey?.created_by || "system",
      tokenHash,
      expiresAt
    )
    .run();

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "invite",
    resourceType: "invitation",
    resourceId: invitationId,
    metadata: { email: normalizedEmail, role },
  });

  // In production, you'd send an email here
  // For now, return the token (only for development)
  const response = {
    invitation: {
      id: invitationId,
      email: normalizedEmail,
      role,
      expiresAt,
      // Only include token in non-production for testing
      ...(c.env.ENVIRONMENT !== "production" && { token }),
    },
  };

  return created(c, response);
});

/**
 * Accept an invitation
 * POST /v1/members/accept
 */
members.post("/accept", async (c) => {
  const body = await c.req.json();
  const parsed = acceptSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { token, name } = parsed.data;
  const tokenHash = await hashString(token);

  // Find invitation
  const invitation = await c.env.DB.prepare(
    `SELECT id, organization_id, email, role, expires_at
     FROM invitations
     WHERE token_hash = ? AND status = 'pending'`
  )
    .bind(tokenHash)
    .first<{
      id: string;
      organization_id: string;
      email: string;
      role: string;
      expires_at: string;
    }>();

  if (!invitation) {
    throw new AppError("INVALID_INVITATION");
  }

  // Check expiration
  if (new Date(invitation.expires_at) < new Date()) {
    await c.env.DB.prepare(`UPDATE invitations SET status = 'expired' WHERE id = ?`)
      .bind(invitation.id)
      .run();
    throw new AppError("EXPIRED_INVITATION");
  }

  // Check if user already exists
  let userId: string;
  const existingUser = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(invitation.email)
    .first<{ id: string }>();

  if (existingUser) {
    userId = existingUser.id;
  } else {
    // Create new user
    userId = generateUserId();
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, email_verified, name, status)
       VALUES (?, ?, 1, ?, 'active')`
    )
      .bind(userId, invitation.email, name || null)
      .run();
  }

  // Create membership
  const memberId = generateMemberId();
  await c.env.DB.prepare(
    `INSERT INTO organization_members (id, organization_id, user_id, role, status)
     VALUES (?, ?, ?, ?, 'active')`
  )
    .bind(memberId, invitation.organization_id, userId, invitation.role)
    .run();

  // Mark invitation as accepted
  await c.env.DB.prepare(`UPDATE invitations SET status = 'accepted' WHERE id = ?`)
    .bind(invitation.id)
    .run();

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    organizationId: invitation.organization_id,
    userId,
    action: "accept_invite",
    resourceType: "invitation",
    resourceId: invitation.id,
  });

  return success(c, {
    member: {
      id: memberId,
      organizationId: invitation.organization_id,
      userId,
      role: invitation.role,
    },
  });
});

/**
 * Remove a member from the organization
 * DELETE /v1/members/:memberId
 */
members.delete("/:memberId", requirePermissions("org:admin"), async (c) => {
  const { memberId } = c.req.param();
  const auth = c.get("apiKey");
  const orgId = auth!.organizationId;

  // Find member
  const member = await c.env.DB.prepare(
    `SELECT id, user_id, role FROM organization_members
     WHERE id = ? AND organization_id = ?`
  )
    .bind(memberId, orgId)
    .first<{ id: string; user_id: string; role: string }>();

  if (!member) {
    throw notFound("Member");
  }

  // Cannot remove the owner
  if (member.role === "owner") {
    throw new AppError("BAD_REQUEST", "Cannot remove the organization owner");
  }

  // Soft delete
  await c.env.DB.prepare(
    `UPDATE organization_members SET status = 'removed' WHERE id = ?`
  )
    .bind(memberId)
    .run();

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "delete",
    resourceType: "member",
    resourceId: memberId,
    metadata: { userId: member.user_id },
  });

  return noContent(c);
});

export default members;
