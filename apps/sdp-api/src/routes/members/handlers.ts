import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { hashString } from "@/lib/hash";
import { created, noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { createEmailService, createInvitationEmail } from "@/services/email";
import type { Env } from "@/types/env";
import type { OrganizationRole } from "@sdp/types";
import type { Context } from "hono";
import { acceptSchema, inviteSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  const globalWithBuffer = globalThis as {
    Buffer?: {
      from: (input: Uint8Array) => { toString: (encoding: "base64") => string };
    };
  };

  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export const listMembers = async (c: AppContext) => {
  const auth = getAuth(c);
  const orgId = auth.organizationId;

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
};

export const inviteMember = async (c: AppContext) => {
  const auth = getAuth(c);
  const orgId = auth.organizationId;

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
    .bind(auth.id)
    .first<{ created_by: string }>();

  const org = await c.env.DB.prepare("SELECT name FROM organizations WHERE id = ?")
    .bind(orgId)
    .first<{ name: string }>();

  const inviter = inviterKey?.created_by
    ? await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
        .bind(inviterKey.created_by)
        .first<{ email: string }>()
    : null;

  // Create invitation
  const invitationId = `inv_${crypto.randomUUID()}`;
  const token = randomBase64Url(32);
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

  const inviteUrl = buildInvitationUrl(c, token);
  const emailMessage = createInvitationEmail({
    email: normalizedEmail,
    inviterEmail: inviter?.email,
    organizationName: org?.name,
    role,
    inviteUrl,
    expiresAt,
  });

  try {
    const emailService = createEmailService(c.env);
    await emailService.sendEmail(emailMessage);
  } catch (error) {
    console.error("Failed to send invitation email:", error);
  }

  // In dev, return token in response for testing
  const response = {
    invitation: {
      id: invitationId,
      email: normalizedEmail,
      role,
      expiresAt,
    },
    ...(c.env.ENVIRONMENT === "development" && { token }),
  };

  return created(c, response);
};

function buildInvitationUrl(c: AppContext, token: string): string {
  const frontendUrl = c.env.FRONTEND_URL?.replace(/\/$/, "");
  if (frontendUrl) {
    return `${frontendUrl}/invite?token=${encodeURIComponent(token)}`;
  }

  const originHeader = c.req.header("Origin");
  if (originHeader) {
    return `${originHeader.replace(/\/$/, "")}/invite?token=${encodeURIComponent(token)}`;
  }

  const referer = c.req.header("Referer");
  if (referer) {
    try {
      const origin = new URL(referer).origin;
      return `${origin}/invite?token=${encodeURIComponent(token)}`;
    } catch {
      // Ignore invalid referer
    }
  }

  const origin = new URL(c.req.url).origin;
  return `${origin}/invite?token=${encodeURIComponent(token)}`;
}

export const acceptInvitation = async (c: AppContext) => {
  const body = await c.req.json();
  const parsed = acceptSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { token, name } = parsed.data;
  const tokenHash = await hashString(token);

  // Get invitation
  const invitation = await c.env.DB.prepare(
    `SELECT id, organization_id, email, role, expires_at, status
     FROM invitations
     WHERE token_hash = ?`
  )
    .bind(tokenHash)
    .first<{
      id: string;
      organization_id: string;
      email: string;
      role: string;
      expires_at: string;
      status: string;
    }>();

  if (!invitation) {
    throw new AppError("INVALID_INVITATION", "Invalid invitation token");
  }

  if (invitation.status !== "pending") {
    throw new AppError("INVALID_INVITATION", "Invitation is no longer valid");
  }

  if (new Date(invitation.expires_at) < new Date()) {
    throw new AppError("EXPIRED_INVITATION", "Invitation has expired");
  }

  // Check if user exists
  let user = await c.env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(invitation.email)
    .first<{ id: string; email: string }>();

  if (!user) {
    // Create new user
    const userId = `usr_${crypto.randomUUID()}`;
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, email_verified, status)
       VALUES (?, ?, ?, 1, 'active')`
    )
      .bind(userId, invitation.email, name ?? null)
      .run();

    user = { id: userId, email: invitation.email };
  }

  // Create membership
  const memberId = `mem_${crypto.randomUUID()}`;
  await c.env.DB.prepare(
    `INSERT INTO organization_members (id, organization_id, user_id, role, status)
     VALUES (?, ?, ?, ?, 'active')`
  )
    .bind(memberId, invitation.organization_id, user.id, invitation.role)
    .run();

  // Mark invitation as accepted
  await c.env.DB.prepare(
    "UPDATE invitations SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?"
  )
    .bind(invitation.id)
    .run();

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "accept_invite",
    resourceType: "invitation",
    resourceId: invitation.id,
    metadata: { email: invitation.email },
  });

  return success(c, { success: true });
};

export const removeMember = async (c: AppContext) => {
  const { memberId } = c.req.param();
  const auth = getAuth(c);

  // Ensure member belongs to same org
  const member = await c.env.DB.prepare(
    "SELECT id, user_id FROM organization_members WHERE id = ? AND organization_id = ?"
  )
    .bind(memberId, auth.organizationId)
    .first<{ id: string; user_id: string }>();

  if (!member) {
    throw notFound("Member");
  }

  await c.env.DB.prepare("UPDATE organization_members SET status = 'removed' WHERE id = ?")
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
};
