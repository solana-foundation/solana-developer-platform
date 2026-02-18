import { AppError, notFound } from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { ClerkOrganizationsService } from "@/services/clerk-organizations.service";
import type { Env } from "@/types/env";
import type { OrganizationRole } from "@sdp/types";
import type { Context } from "hono";
import { inviteSchema } from "./schemas";

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
  if (role === "owner" || role === "admin") {
    return "org:admin";
  }
  return "org:member";
}

async function getClerkOrgId(db: D1Database, organizationId: string): Promise<string | null> {
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

function parseHostname(urlValue: string | undefined): string | undefined {
  const value = urlValue?.trim();
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function resolveDynamicInviteRedirectUrl(c: AppContext): string | undefined {
  const originHeader = c.req.header("x-sdp-web-origin")?.trim();
  if (!originHeader) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (!isLocal && parsed.protocol !== "https:") {
    return undefined;
  }

  const exactAllowedHosts = [
    parseHostname(c.env.CLERK_INVITATION_REDIRECT_URL),
    parseHostname(c.env.FRONTEND_URL),
  ].filter((value): value is string => Boolean(value));

  const suffixes = c.env.CLERK_INVITATION_REDIRECT_ALLOWED_HOST_SUFFIXES?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const hostAllowed =
    exactAllowedHosts.includes(host) ||
    Boolean(suffixes?.some((suffix) => host.endsWith(suffix.replace(/^\*\./, "."))));

  if (!hostAllowed) {
    return undefined;
  }

  return `${parsed.origin}/sign-in`;
}

function resolveInviteRedirectUrl(c: AppContext): string | undefined {
  const dynamic = resolveDynamicInviteRedirectUrl(c);
  if (dynamic) {
    return dynamic;
  }

  const env = c.env;
  const configured = env.CLERK_INVITATION_REDIRECT_URL?.trim();
  if (configured) {
    return configured;
  }

  const base = env.FRONTEND_URL?.trim().replace(/\/$/, "");
  if (!base) {
    return undefined;
  }
  return `${base}/sign-in`;
}

function assertInviteRedirectUrl(env: Env, redirectUrl: string | undefined): string | undefined {
  if (env.ENVIRONMENT === "development") {
    return redirectUrl;
  }

  if (!redirectUrl) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Invite redirect URL is missing. Set CLERK_INVITATION_REDIRECT_URL or FRONTEND_URL."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    throw new AppError(
      "INTERNAL_ERROR",
      "Invite redirect URL is invalid. Set CLERK_INVITATION_REDIRECT_URL to a full https URL."
    );
  }

  if (parsed.protocol !== "https:") {
    throw new AppError(
      "INTERNAL_ERROR",
      "Invite redirect URL must use https in a non-development environment."
    );
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]";

  if (isLoopback) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Invite redirect URL points to a loopback host in a non-development environment."
    );
  }

  return redirectUrl;
}

export const listMembers = async (c: AppContext) => {
  const { organizationId } = resolveActor(c);

  const results = await c.env.DB.prepare(
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
  const { organizationId, userId, apiKeyId } = resolveActor(c);
  const clerk = c.get("clerk");

  const body = await c.req.json();
  const parsed = inviteSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { email, role } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();
  const clerkRole = mapRoleToClerkRole(role);

  // Check if user already exists and is a member
  const existingMember = await c.env.DB.prepare(
    `SELECT om.id FROM organization_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.organization_id = ? AND u.email = ? AND om.status = 'active'`
  )
    .bind(organizationId, normalizedEmail)
    .first();

  if (existingMember) {
    throw new AppError("CONFLICT", "User is already a member of this organization");
  }

  if (!clerk?.clerkUserId) {
    throw new AppError("UNAUTHORIZED", "Clerk user required to send invites");
  }

  const clerkOrgId = await getClerkOrgId(c.env.DB, organizationId);
  if (!clerkOrgId) {
    throw new AppError("BAD_REQUEST", "Organization is not linked to Clerk");
  }

  const inviterKey =
    apiKeyId !== null
      ? await c.env.DB.prepare("SELECT created_by FROM api_keys WHERE id = ?")
          .bind(apiKeyId)
          .first<{ created_by: string }>()
      : null;

  const inviterUserId = userId || inviterKey?.created_by || null;

  const clerkService = new ClerkOrganizationsService(c.env);
  const redirectUrl = assertInviteRedirectUrl(c.env, resolveInviteRedirectUrl(c));
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

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "invite",
    resourceType: "invitation",
    resourceId: clerkInvitation.id,
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

  return created(c, {
    invitation: {
      id: clerkInvitation.id,
      email: normalizedEmail,
      role,
      status: clerkInvitation.status,
      createdAt: clerkInvitation.created_at
        ? new Date(clerkInvitation.created_at).toISOString()
        : undefined,
    },
  });
};

export const removeMember = async (c: AppContext) => {
  const { memberId } = c.req.param();
  const { organizationId, userId, apiKeyId } = resolveActor(c);

  // Ensure member belongs to same org
  const member = await c.env.DB.prepare(
    "SELECT id, user_id FROM organization_members WHERE id = ? AND organization_id = ?"
  )
    .bind(memberId, organizationId)
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
    organizationId,
    userId: userId || undefined,
    apiKeyId: apiKeyId || undefined,
  });

  return noContent(c);
};
