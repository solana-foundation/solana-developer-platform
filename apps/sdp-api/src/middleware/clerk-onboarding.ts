import type { Context, Next } from "hono";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db/identity";
import {
  extractBearerToken,
  resolveClerkEmail,
  resolveClerkOrganizationClaims,
  verifyClerkSessionToken,
} from "@/lib/clerk-token";
import { unauthorized } from "@/lib/errors";
import { findClerkOrganizationMapping } from "@/services/clerk-organization-provisioning.service";
import type { Env } from "@/types/env";

export function clerkOnboardingMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const token = extractBearerToken(c);

    if (!token) {
      throw unauthorized("Clerk session required");
    }

    const payload = await verifyClerkSessionToken(c, token);

    if (!payload.sub) {
      throw unauthorized("Clerk token missing subject");
    }

    const organization = resolveClerkOrganizationClaims(payload);
    if (!organization.organizationId) {
      throw unauthorized("Clerk token missing organization");
    }
    const clerkOrgId = organization.organizationId;

    const email = resolveClerkEmail(payload);
    if (!email) {
      throw unauthorized(
        "Clerk token has no usable email claim. Check the session token customization: an invalid shortcode is passed through unsubstituted rather than resolved."
      );
    }

    // The Clerk-org -> organization mapping lives in an RLS-forced table
    // (migration 0081) and must be read before a tenant identity exists, so
    // the lookup runs under the system identity (the same boundary
    // clerk-auth.ts draws) and the rest of the request narrows to the mapped
    // organization. An unlinked Clerk org proceeds with the ambient
    // no-identity context: tenant-table reads stay empty and the handlers
    // answer linked:false / Organization not found instead of leaking anything.
    const mapping = await runWithSystemDatabaseIdentity("http:auth", () =>
      findClerkOrganizationMapping(getDb(c.env), clerkOrgId)
    );

    c.set("clerkOnboarding", {
      clerkUserId: payload.sub,
      clerkOrgId,
      orgSlug: organization.organizationSlug,
      email,
      organizationId: mapping ? mapping.organizationId : null,
    });

    if (mapping) {
      await runWithTenantDatabaseIdentity({ organizationId: mapping.organizationId }, next);
      return;
    }

    await next();
  };
}
