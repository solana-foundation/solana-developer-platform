/**
 * Clerk Authentication Middleware (Option A)
 *
 * Verifies Clerk JWTs, maps external identities to internal users/orgs,
 * and sets a Clerk auth context for downstream handlers.
 */

import { AppError, unauthorized } from "@/lib/errors";
import {
  type ClerkJwtPayload,
  extractBearerToken,
  resolveClerkEmail,
  verifyClerkJwt,
} from "@/lib/clerk-token";
import type { Env } from "@/types/env";
import { getPermissionsForOrgRole } from "@sdp/types";
import type { Context, Next } from "hono";

type OrganizationRole = "owner" | "admin" | "developer" | "viewer";

async function resolveClerkUser(db: D1Database, clerkUserId: string) {
  return db
    .prepare(
      `SELECT user_id, email
       FROM auth_user_identities
       WHERE provider = 'clerk' AND provider_user_id = ?`
    )
    .bind(clerkUserId)
    .first<{ user_id: string; email: string | null }>();
}

async function resolveClerkOrganization(db: D1Database, clerkOrgId: string) {
  return db
    .prepare(
      `SELECT organization_id, slug
       FROM auth_organization_identities
       WHERE provider = 'clerk' AND provider_org_id = ?`
    )
    .bind(clerkOrgId)
    .first<{ organization_id: string; slug: string | null }>();
}

async function resolveOrgRole(db: D1Database, userId: string, organizationId: string) {
  return db
    .prepare(
      `SELECT role
       FROM organization_members
       WHERE user_id = ? AND organization_id = ? AND status = 'active'`
    )
    .bind(userId, organizationId)
    .first<{ role: string }>();
}

function mapClerkRoleToOrgRole(role: string | null | undefined): OrganizationRole {
  if (role === "org:admin") {
    return "admin";
  }
  return "developer";
}

async function ensureClerkUser(
  db: D1Database,
  clerkUserId: string,
  email: string
): Promise<{ userId: string; email: string }> {
  const existing = await resolveClerkUser(db, clerkUserId);
  if (existing) {
    return { userId: existing.user_id, email: existing.email ?? email };
  }

  const normalizedEmail = email.toLowerCase();
  let user = await db
    .prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(normalizedEmail)
    .first<{ id: string; email: string }>();

  if (!user) {
    const userId = `usr_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, ?, 1, 'active')`
      )
      .bind(userId, normalizedEmail)
      .run();
    user = { id: userId, email: normalizedEmail };
  }

  try {
    await db
      .prepare(
        `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(`aui_${crypto.randomUUID()}`, clerkUserId, user.id, normalizedEmail)
      .run();
  } catch {
    // Ignore if another request created the mapping
  }

  return { userId: user.id, email: user.email };
}

async function ensureMembership(
  db: D1Database,
  params: {
    organizationId: string;
    userId: string;
    email: string;
    clerkRole?: string | null;
  }
): Promise<OrganizationRole> {
  const existing = await resolveOrgRole(db, params.userId, params.organizationId);
  if (existing?.role) {
    return existing.role as OrganizationRole;
  }

  const pendingInvite = await db
    .prepare(
      `SELECT id, role, expires_at
       FROM invitations
       WHERE organization_id = ? AND email = ? AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(params.organizationId, params.email.toLowerCase())
    .first<{ id: string; role: string; expires_at: string }>();

  let role: OrganizationRole | null = null;

  if (pendingInvite) {
    if (new Date(pendingInvite.expires_at) >= new Date()) {
      role = pendingInvite.role as OrganizationRole;
    } else {
      await db
        .prepare("UPDATE invitations SET status = 'expired' WHERE id = ?")
        .bind(pendingInvite.id)
        .run();
    }
  }

  if (!role) {
    role = mapClerkRoleToOrgRole(params.clerkRole);
  }

  const memberId = `mem_${crypto.randomUUID()}`;
  try {
    await db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(memberId, params.organizationId, params.userId, role)
      .run();
  } catch {
    const existingAfterInsert = await resolveOrgRole(
      db,
      params.userId,
      params.organizationId
    );
    if (existingAfterInsert?.role) {
      return existingAfterInsert.role as OrganizationRole;
    }
  }

  if (pendingInvite && role === (pendingInvite.role as OrganizationRole)) {
    await db
      .prepare(
        "UPDATE invitations SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?"
      )
      .bind(pendingInvite.id)
      .run();
  }

  return role;
}

async function buildClerkContext(
  c: Context<{ Bindings: Env }>,
  payload: ClerkJwtPayload
) {
  const email = resolveClerkEmail(payload);
  if (!email) {
    throw new AppError("UNAUTHORIZED", "Clerk token missing email");
  }

  const [userIdentity, orgIdentity] = await Promise.all([
    ensureClerkUser(c.env.DB, payload.sub as string, email),
    resolveClerkOrganization(c.env.DB, payload.org_id as string),
  ]);

  if (!orgIdentity) {
    throw new AppError("UNAUTHORIZED", "Clerk organization is not linked");
  }

  const role = await ensureMembership(c.env.DB, {
    organizationId: orgIdentity.organization_id,
    userId: userIdentity.userId,
    email,
    clerkRole: payload.org_role,
  });

  const permissions = getPermissionsForOrgRole(role);

  return {
    userId: userIdentity.userId,
    organizationId: orgIdentity.organization_id,
    permissions,
    role,
    clerkUserId: payload.sub as string,
    clerkOrgId: payload.org_id as string,
    email: email || userIdentity.email,
    orgSlug: payload.org_slug ?? orgIdentity.slug,
    orgRole: payload.org_role ?? null,
  };
}

export function clerkAuthMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const token = extractBearerToken(c);

    if (!token) {
      throw unauthorized("Clerk session required");
    }

    let payload: ClerkJwtPayload;
    try {
      payload = await verifyClerkJwt(token, c.env);
    } catch (error) {
      throw new AppError("UNAUTHORIZED", "Invalid Clerk token", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (!payload.sub) {
      throw new AppError("UNAUTHORIZED", "Clerk token missing subject");
    }

    if (!payload.org_id) {
      throw new AppError("UNAUTHORIZED", "Clerk token missing organization");
    }

    const clerkContext = await buildClerkContext(c, payload);
    c.set("clerk", clerkContext);

    await next();
  };
}

export function optionalClerkAuth() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const token = extractBearerToken(c);

    if (!token) {
      await next();
      return;
    }

    try {
      const payload = await verifyClerkJwt(token, c.env);

      if (payload.sub && payload.org_id) {
        const clerkContext = await buildClerkContext(c, payload);
        if (clerkContext) {
          c.set("clerk", clerkContext);
        }
      }
    } catch {
      // Ignore invalid Clerk auth for optional usage
    }

    await next();
  };
}
