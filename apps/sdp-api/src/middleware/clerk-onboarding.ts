import type { Context, Next } from "hono";
import { getDb, runWithSystemDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db";
import {
  type ClerkJwtPayload,
  extractBearerToken,
  resolveClerkEmail,
  verifyClerkJwtForRequest,
} from "@/lib/clerk-token";
import { AppError, unauthorized } from "@/lib/errors";
import type { Env } from "@/types/env";

export function clerkOnboardingMiddleware() {
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

    const email = resolveClerkEmail(payload);
    if (!email) {
      throw new AppError(
        "UNAUTHORIZED",
        "Clerk token has no usable email claim. Check the session token customization: an invalid shortcode is passed through unsubstituted rather than resolved."
      );
    }

    c.set("clerkOnboarding", {
      clerkUserId: payload.sub,
      clerkOrgId: payload.org_id,
      orgSlug: payload.org_slug ?? null,
      orgRole: payload.org_role ?? null,
      email,
    });

    // The Clerk-org -> organization mapping lives in an RLS-forced table
    // (migration 0081) and must be read before a tenant identity exists, so
    // the lookup runs under the system identity (the same boundary
    // clerk-auth.ts draws) and the rest of the request narrows to the mapped
    // organization. An unlinked Clerk org proceeds with the ambient
    // no-identity context: tenant-table reads stay empty and the handlers
    // answer linked:false / Organization not found instead of leaking anything.
    const mapping = await runWithSystemDatabaseIdentity("http:auth", () =>
      getDb(c.env)
        .prepare(
          `SELECT organization_id
           FROM auth_organization_identities
           WHERE provider = 'clerk' AND provider_org_id = ?`
        )
        .bind(payload.org_id)
        .first<{ organization_id: string }>()
    );

    if (mapping) {
      await runWithTenantDatabaseIdentity({ organizationId: mapping.organization_id }, next);
      return;
    }

    await next();
  };
}
