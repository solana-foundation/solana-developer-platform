/**
 * Clerk Authentication Middleware (Option A)
 *
 * Verifies Clerk JWTs, maps external identities to internal users/orgs,
 * and sets a Clerk auth context for downstream handlers.
 */

import { AppError, forbidden, internalError, unauthorized } from "@/lib/errors";
import type { Env } from "@/types/env";
import { getPermissionsForOrgRole } from "@sdp/types";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Context, Next } from "hono";

type OrganizationRole = "owner" | "admin" | "developer" | "viewer";

interface ClerkJwtPayload extends JWTPayload {
  sub?: string;
  org_id?: string | null;
  org_role?: string | null;
  org_slug?: string | null;
  email?: string;
  email_addresses?: Array<{ email_address: string }>;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(jwksUrl: string) {
  const cached = jwksCache.get(jwksUrl);
  if (cached) {
    return cached;
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  jwksCache.set(jwksUrl, jwks);
  return jwks;
}

function extractBearerToken(c: Context<{ Bindings: Env }>): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return null;
  }

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7);
}

function resolveClerkEmail(payload: ClerkJwtPayload): string | null {
  if (payload.email) {
    return payload.email;
  }

  const first = payload.email_addresses?.[0]?.email_address;
  return first ?? null;
}

function resolveClerkConfig(env: Env) {
  const issuer = env.CLERK_ISSUER?.trim();
  const jwksUrl = env.CLERK_JWKS_URL?.trim();
  const audience = env.CLERK_AUDIENCE?.trim();

  if (!issuer && !jwksUrl) {
    throw internalError("Clerk auth is not configured");
  }

  if (!issuer) {
    throw internalError("CLERK_ISSUER is required for Clerk auth");
  }

  const resolvedJwksUrl = jwksUrl || `${issuer}/.well-known/jwks.json`;

  return {
    issuer,
    jwksUrl: resolvedJwksUrl,
    audience: audience || undefined,
  };
}

async function verifyClerkJwt(token: string, env: Env): Promise<ClerkJwtPayload> {
  const config = resolveClerkConfig(env);
  const jwks = getJwks(config.jwksUrl);

  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.issuer,
    audience: config.audience,
  });

  return payload as ClerkJwtPayload;
}

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

    const [userIdentity, orgIdentity] = await Promise.all([
      resolveClerkUser(c.env.DB, payload.sub),
      resolveClerkOrganization(c.env.DB, payload.org_id),
    ]);

    if (!userIdentity) {
      throw new AppError("UNAUTHORIZED", "Clerk user is not linked");
    }

    if (!orgIdentity) {
      throw new AppError("UNAUTHORIZED", "Clerk organization is not linked");
    }

    const membership = await resolveOrgRole(
      c.env.DB,
      userIdentity.user_id,
      orgIdentity.organization_id
    );

    if (!membership) {
      throw forbidden("User is not a member of this organization");
    }

    const permissions = getPermissionsForOrgRole(membership.role as OrganizationRole);

    c.set("clerk", {
      userId: userIdentity.user_id,
      organizationId: orgIdentity.organization_id,
      permissions,
      role: membership.role,
      clerkUserId: payload.sub,
      clerkOrgId: payload.org_id,
      email: resolveClerkEmail(payload) || userIdentity.email,
      orgSlug: payload.org_slug ?? orgIdentity.slug,
      orgRole: payload.org_role ?? null,
    });

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
        const [userIdentity, orgIdentity] = await Promise.all([
          resolveClerkUser(c.env.DB, payload.sub),
          resolveClerkOrganization(c.env.DB, payload.org_id),
        ]);

        if (userIdentity && orgIdentity) {
          const membership = await resolveOrgRole(
            c.env.DB,
            userIdentity.user_id,
            orgIdentity.organization_id
          );

          if (membership) {
            const permissions = getPermissionsForOrgRole(
              membership.role as OrganizationRole
            );

            c.set("clerk", {
              userId: userIdentity.user_id,
              organizationId: orgIdentity.organization_id,
              permissions,
              role: membership.role,
              clerkUserId: payload.sub,
              clerkOrgId: payload.org_id,
              email: resolveClerkEmail(payload) || userIdentity.email,
              orgSlug: payload.org_slug ?? orgIdentity.slug,
              orgRole: payload.org_role ?? null,
            });
          }
        }
      }
    } catch {
      // Ignore invalid Clerk auth for optional usage
    }

    await next();
  };
}
