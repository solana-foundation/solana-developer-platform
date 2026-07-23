/**
 * Clerk Authentication Middleware (Option A)
 *
 * Verifies Clerk JWTs, maps external identities to internal users/orgs,
 * and sets a Clerk auth context for downstream handlers.
 */

import {
  getPermissionsForOrgRole,
  normalizeOrganizationRole,
  type OrganizationRole,
} from "@sdp/types";
import type { Context, Next } from "hono";
import { getDb } from "@/db";
import { mapClerkRoleToOrgRole } from "@/lib/clerk-role";
import {
  type ClerkJwtPayload,
  extractBearerToken,
  resolveClerkEmail,
  verifyClerkJwtForRequest,
} from "@/lib/clerk-token";
import { AppError, unauthorized } from "@/lib/errors";
import { ensureClerkOrganizationMapping } from "@/services/clerk-organization-provisioning.service";
import { ClerkOrganizationsService } from "@/services/clerk-organizations.service";
import {
  ClerkUsersService,
  verifiedPrimaryEmailFromClerkUser,
} from "@/services/clerk-users.service";
import { ProjectService } from "@/services/project.service";
import type { Env } from "@/types/env";

async function resolveClerkUser(db: DatabaseClient, clerkUserId: string) {
  return db
    .prepare(
      `SELECT aui.user_id, COALESCE(aui.email, u.email) AS email
       FROM auth_user_identities aui
       LEFT JOIN users u ON u.id = aui.user_id
       WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
    )
    .bind(clerkUserId)
    .first<{ user_id: string; email: string | null }>();
}

async function resolveClerkOrganization(db: DatabaseClient, clerkOrgId: string) {
  return db
    .prepare(
      `SELECT organization_id, slug
       FROM auth_organization_identities
       WHERE provider = 'clerk' AND provider_org_id = ?`
    )
    .bind(clerkOrgId)
    .first<{ organization_id: string; slug: string | null }>();
}

async function resolveExistingClerkContext(
  db: DatabaseClient,
  params: {
    clerkUserId: string;
    clerkOrgId: string;
    fallbackEmail: string;
    fallbackOrgSlug: string | null;
  }
) {
  return db
    .prepare(
      `SELECT
         aui.user_id,
         COALESCE(aui.email, u.email, ?) AS email,
         aoi.organization_id,
         COALESCE(aoi.slug, ?) AS org_slug,
         om.role,
         EXISTS (
           SELECT 1
           FROM projects p
           JOIN project_members pm
             ON pm.project_id = p.id AND pm.user_id = aui.user_id
           WHERE p.organization_id = aoi.organization_id
             AND p.slug = 'default-sandbox'
             AND p.status = 'active'
         ) AS has_default_sandbox,
         EXISTS (
           SELECT 1
           FROM projects p
           JOIN project_members pm
             ON pm.project_id = p.id AND pm.user_id = aui.user_id
           WHERE p.organization_id = aoi.organization_id
             AND p.slug = 'default-production'
             AND p.status = 'active'
         ) AS has_default_production
       FROM auth_organization_identities aoi
       LEFT JOIN auth_user_identities aui
         ON aui.provider = 'clerk' AND aui.provider_user_id = ?
       LEFT JOIN users u
         ON u.id = aui.user_id
       LEFT JOIN organization_members om
         ON om.user_id = aui.user_id
        AND om.organization_id = aoi.organization_id
        AND om.status = 'active'
       WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?
       LIMIT 1`
    )
    .bind(
      params.fallbackEmail.toLowerCase(),
      params.fallbackOrgSlug,
      params.clerkUserId,
      params.clerkOrgId
    )
    .first<{
      user_id: string | null;
      email: string | null;
      organization_id: string;
      org_slug: string | null;
      role: string | null;
      has_default_sandbox: boolean | number;
      has_default_production: boolean | number;
    }>();
}

async function resolveOrgMembership(db: DatabaseClient, userId: string, organizationId: string) {
  return db
    .prepare(
      `SELECT role, status
       FROM organization_members
       WHERE user_id = ? AND organization_id = ?`
    )
    .bind(userId, organizationId)
    .first<{ role: string; status: string }>();
}

async function ensureClerkUser(
  env: Env,
  db: DatabaseClient,
  clerkUserId: string,
  fallbackEmail: string
): Promise<{ userId: string; email: string }> {
  const existing = await resolveClerkUser(db, clerkUserId);
  if (existing) {
    return { userId: existing.user_id, email: existing.email ?? fallbackEmail };
  }

  const clerkUser = await new ClerkUsersService(env).getUser(clerkUserId);
  const normalizedEmail = verifiedPrimaryEmailFromClerkUser(clerkUser);
  if (!normalizedEmail) {
    throw unauthorized("Clerk primary email must be verified");
  }
  let user = await db
    .prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(normalizedEmail)
    .first<{ id: string; email: string }>();

  if (!user) {
    const userId = `usr_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, ?, 1, 'active')
         ON CONFLICT (email) DO NOTHING`
      )
      .bind(userId, normalizedEmail)
      .run();
    user = await db
      .prepare("SELECT id, email FROM users WHERE email = ?")
      .bind(normalizedEmail)
      .first<{ id: string; email: string }>();
  }

  if (!user) {
    throw new AppError("INTERNAL_ERROR", "Unable to resolve Clerk user");
  }

  await db
    .prepare(
      `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
       VALUES (?, 'clerk', ?, ?, ?)
       ON CONFLICT (provider, provider_user_id)
       DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, updated_at = sdp_datetime_now()`
    )
    .bind(`aui_${crypto.randomUUID()}`, clerkUserId, user.id, normalizedEmail)
    .run();

  return { userId: user.id, email: user.email };
}

async function ensureMembership(
  db: DatabaseClient,
  params: {
    organizationId: string;
    userId: string;
    email: string;
    clerkRole?: string | null;
  }
): Promise<OrganizationRole> {
  const existing = await resolveOrgMembership(db, params.userId, params.organizationId);
  if (existing && existing.status !== "active") {
    throw unauthorized("Organization membership is inactive");
  }
  if (existing) {
    const normalizedRole = normalizeOrganizationRole(existing.role);
    if (normalizedRole !== existing.role) {
      await db
        .prepare(
          `UPDATE organization_members
           SET role = ?
           WHERE user_id = ? AND organization_id = ? AND status = 'active'`
        )
        .bind(normalizedRole, params.userId, params.organizationId)
        .run();
    }
    return normalizedRole;
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
      role = normalizeOrganizationRole(pendingInvite.role);
      if (role !== pendingInvite.role) {
        await db
          .prepare("UPDATE invitations SET role = ? WHERE id = ?")
          .bind(role, pendingInvite.id)
          .run();
      }
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
  } catch (error) {
    const existingAfterInsert = await resolveOrgMembership(
      db,
      params.userId,
      params.organizationId
    );
    if (existingAfterInsert?.status === "active") {
      return normalizeOrganizationRole(existingAfterInsert.role);
    }
    if (existingAfterInsert) {
      throw unauthorized("Organization membership is inactive");
    }
    throw error;
  }

  if (pendingInvite && role === normalizeOrganizationRole(pendingInvite.role)) {
    await db
      .prepare(
        "UPDATE invitations SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?"
      )
      .bind(pendingInvite.id)
      .run();
  }

  return role;
}

async function ensureDefaultProjects(
  db: DatabaseClient,
  organizationId: string,
  userId: string
): Promise<void> {
  const projectService = new ProjectService(db);
  await Promise.all([
    projectService.findOrCreateDefault(organizationId, "sandbox", userId),
    projectService.findOrCreateDefault(organizationId, "production", userId),
  ]);
}

async function buildClerkContext(c: Context<{ Bindings: Env }>, payload: ClerkJwtPayload) {
  const email = resolveClerkEmail(payload);
  if (!email) {
    throw new AppError("UNAUTHORIZED", "Clerk token missing email");
  }

  const existingContext = await resolveExistingClerkContext(getDb(c.env), {
    clerkUserId: payload.sub as string,
    clerkOrgId: payload.org_id as string,
    fallbackEmail: email,
    fallbackOrgSlug: payload.org_slug ?? null,
  });

  if (existingContext?.organization_id && existingContext.user_id && existingContext.role) {
    const role = normalizeOrganizationRole(existingContext.role);

    if (role !== existingContext.role) {
      await getDb(c.env)
        .prepare(
          `UPDATE organization_members
           SET role = ?
           WHERE user_id = ? AND organization_id = ? AND status = 'active'`
        )
        .bind(role, existingContext.user_id, existingContext.organization_id)
        .run();
    }

    if (!existingContext.has_default_sandbox || !existingContext.has_default_production) {
      await ensureDefaultProjects(
        getDb(c.env),
        existingContext.organization_id,
        existingContext.user_id
      );
    }

    return {
      userId: existingContext.user_id,
      organizationId: existingContext.organization_id,
      permissions: getPermissionsForOrgRole(role),
      role,
      clerkUserId: payload.sub as string,
      clerkOrgId: payload.org_id as string,
      email: existingContext.email ?? email,
      orgSlug: payload.org_slug ?? existingContext.org_slug,
      orgRole: payload.org_role ?? null,
    };
  }

  const [userIdentity, orgIdentity] = await Promise.all([
    ensureClerkUser(c.env, getDb(c.env), payload.sub as string, email),
    resolveClerkOrganization(getDb(c.env), payload.org_id as string),
  ]);

  let resolvedOrgIdentity = orgIdentity;
  if (!resolvedOrgIdentity) {
    const organization = await new ClerkOrganizationsService(c.env).getOrganization(
      payload.org_id as string
    );
    const mapping = await ensureClerkOrganizationMapping({
      env: c.env,
      db: getDb(c.env),
      organization,
    });
    resolvedOrgIdentity = {
      organization_id: mapping.organizationId,
      slug: mapping.slug,
    };
  }

  const role = await ensureMembership(getDb(c.env), {
    organizationId: resolvedOrgIdentity.organization_id,
    userId: userIdentity.userId,
    email: userIdentity.email,
    clerkRole: payload.org_role,
  });
  await ensureDefaultProjects(
    getDb(c.env),
    resolvedOrgIdentity.organization_id,
    userIdentity.userId
  );

  const permissions = getPermissionsForOrgRole(role);

  return {
    userId: userIdentity.userId,
    organizationId: resolvedOrgIdentity.organization_id,
    permissions,
    role,
    clerkUserId: payload.sub as string,
    clerkOrgId: payload.org_id as string,
    email: userIdentity.email,
    orgSlug: payload.org_slug ?? resolvedOrgIdentity.slug,
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
      payload = await verifyClerkJwtForRequest(c, token);
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
      const payload = await verifyClerkJwtForRequest(c, token);

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
