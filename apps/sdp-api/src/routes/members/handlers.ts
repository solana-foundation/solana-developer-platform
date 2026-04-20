import { normalizeOrganizationRole, type OrganizationRole } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { AppError, notFound } from "@/lib/errors";
import { hashString } from "@/lib/hash";
import { created, noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { ClerkOrganizationsService } from "@/services/clerk-organizations.service";
import type { Env } from "@/types/env";
import { acceptSchema, inviteSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

function resolveActor(c: AppContext): {
  organizationId: string;
  userId: string | null;
  apiKeyId: string | null;
} {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return {
      organizationId: apiKey.organizationId,
      userId: null,
      apiKeyId: apiKey.id,
    };
  }

  const clerk = c.get("clerk");
  if (clerk) {
    return {
      organizationId: clerk.organizationId,
      userId: clerk.userId,
      apiKeyId: null,
    };
  }

  const session = c.get("session");
  if (session) {
    return {
      organizationId: session.organizationId,
      userId: session.userId,
      apiKeyId: null,
    };
  }

  throw new AppError("UNAUTHORIZED", "Authentication required");
}

function mapRoleToClerkRole(role: OrganizationRole): string {
  if (role === "admin") {
    return "org:admin";
  }
  return "org:member";
}

async function getClerkOrgId(db: DatabaseClient, organizationId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT provider_org_id
       FROM auth_organization_identities
       WHERE provider = 'clerk' AND organization_id = ?`
    )
    .bind(organizationId)
    .first<{ provider_org_id: string }>();

  return row?.provider_org_id ?? null;
}

function resolveInviteRedirectUrl(env: Env): string | undefined {
  const base = env.FRONTEND_URL?.replace(/\/$/, "");
  if (!base) {
    return undefined;
  }
  return `${base}/members`;
}

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
  const { organizationId } = resolveActor(c);

  const results = await getDb(c.env)
    .prepare(
      `SELECT om.id, om.role, om.status, om.created_at,
            u.id as user_id, u.email, u.name
     FROM organization_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.organization_id = ? AND om.status = 'active'
     ORDER BY om.created_at ASC`
    )
    .bind(organizationId)
    .all();

  const memberList = results.results.map((row) => ({
    id: row.id as string,
    role: normalizeOrganizationRole(row.role as string),
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
  const { organizationId, userId, apiKeyId } = resolveActor(c);
  const clerk = c.get("clerk");

  const body = await c.req.json();
  const parsed = inviteSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { email } = parsed.data;
  const role = normalizeOrganizationRole(parsed.data.role);
  const normalizedEmail = email.toLowerCase().trim();
  const clerkRole = mapRoleToClerkRole(role);

  // Check if user already exists and is a member
  const existingMember = await getDb(c.env)
    .prepare(
      `SELECT om.id FROM organization_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.organization_id = ? AND u.email = ? AND om.status = 'active'`
    )
    .bind(organizationId, normalizedEmail)
    .first();

  if (existingMember) {
    throw new AppError("CONFLICT", "User is already a member of this organization");
  }

  // Check for pending invitation
  const existingInvite = await getDb(c.env)
    .prepare(
      `SELECT id FROM invitations
     WHERE organization_id = ? AND email = ? AND status = 'pending'`
    )
    .bind(organizationId, normalizedEmail)
    .first();

  if (existingInvite) {
    throw new AppError("CONFLICT", "Invitation already sent to this email");
  }

  if (!clerk?.clerkUserId) {
    throw new AppError("UNAUTHORIZED", "Clerk user required to send invites");
  }

  const clerkOrgId = await getClerkOrgId(getDb(c.env), organizationId);
  if (!clerkOrgId) {
    throw new AppError("BAD_REQUEST", "Organization is not linked to Clerk");
  }

  const inviterKey =
    apiKeyId !== null
      ? await getDb(c.env)
          .prepare("SELECT created_by FROM api_keys WHERE id = ?")
          .bind(apiKeyId)
          .first<{ created_by: string }>()
      : null;

  const inviterUserId = userId || inviterKey?.created_by || null;

  const clerkService = new ClerkOrganizationsService(c.env);
  const redirectUrl = resolveInviteRedirectUrl(c.env);
  const clerkInvitation = await clerkService.createOrganizationInvitation({
    organizationId: clerkOrgId,
    inviterUserId: clerk.clerkUserId,
    emailAddress: normalizedEmail,
    role: clerkRole,
    redirectUrl,
    publicMetadata: {
      sdpRole: role,
      sdpOrganizationId: organizationId,
    },
  });

  // Create local invitation record for role mapping
  const invitationId = `inv_${crypto.randomUUID()}`;
  const token = randomBase64Url(32);
  const tokenHash = await hashString(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  await getDb(c.env)
    .prepare(
      `INSERT INTO invitations (id, organization_id, email, role, invited_by, token_hash, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .bind(
      invitationId,
      organizationId,
      normalizedEmail,
      role,
      inviterUserId || "system",
      tokenHash,
      expiresAt
    )
    .run();

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "invite",
    resourceType: "invitation",
    resourceId: invitationId,
    metadata: {
      email: normalizedEmail,
      role,
      clerkInvitationId: clerkInvitation.id,
      clerkRole,
    },
    organizationId: organizationId,
    userId: inviterUserId || undefined,
    apiKeyId: apiKeyId || undefined,
  });

  const response = {
    invitation: {
      id: invitationId,
      email: normalizedEmail,
      role,
      expiresAt,
      clerkInvitationId: clerkInvitation.id,
    },
    ...(c.env.ENVIRONMENT === "development" && { token }),
  };

  return created(c, response);
};

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
  const invitation = await getDb(c.env)
    .prepare(
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
  let user = await getDb(c.env)
    .prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(invitation.email)
    .first<{ id: string; email: string }>();

  if (!user) {
    // Create new user
    const userId = `usr_${crypto.randomUUID()}`;
    await getDb(c.env)
      .prepare(
        `INSERT INTO users (id, email, name, email_verified, status)
       VALUES (?, ?, ?, 1, 'active')`
      )
      .bind(userId, invitation.email, name ?? null)
      .run();

    user = { id: userId, email: invitation.email };
  }

  // Create membership
  const memberId = `mem_${crypto.randomUUID()}`;
  await getDb(c.env)
    .prepare(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status)
     VALUES (?, ?, ?, ?, 'active')`
    )
    .bind(memberId, invitation.organization_id, user.id, normalizeOrganizationRole(invitation.role))
    .run();

  // Mark invitation as accepted
  await getDb(c.env)
    .prepare(
      "UPDATE invitations SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?"
    )
    .bind(invitation.id)
    .run();

  // Audit log
  const auditService = new AuditService(getDb(c.env));
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
  const { organizationId, userId, apiKeyId } = resolveActor(c);

  // Ensure member belongs to same org
  const member = await getDb(c.env)
    .prepare("SELECT id, user_id FROM organization_members WHERE id = ? AND organization_id = ?")
    .bind(memberId, organizationId)
    .first<{ id: string; user_id: string }>();

  if (!member) {
    throw notFound("Member");
  }

  await getDb(c.env)
    .prepare("UPDATE organization_members SET status = 'removed' WHERE id = ?")
    .bind(memberId)
    .run();

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "delete",
    resourceType: "member",
    resourceId: memberId,
    metadata: { userId: member.user_id },
    organizationId,
    userId: userId || undefined,
    apiKeyId: apiKeyId || undefined,
  });

  return noContent(c);
};
