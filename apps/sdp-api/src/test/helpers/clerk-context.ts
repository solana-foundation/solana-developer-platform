import assert from "node:assert/strict";
import { getPermissionsForOrgRole } from "@sdp/types";
import type { ClerkAuthContext } from "@/lib/auth";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { ensureTestClerkIssuer, signTestClerkJwt } from "@/test/helpers/clerk";
import type { Env } from "@/types/env";

export async function testClerkContext(env: Env): Promise<ClerkAuthContext> {
  await ensureTestClerkIssuer(env);
  const token = await signTestClerkJwt({
    clerkUserId: "clerk_user_service",
    clerkOrgId: "clerk_org_service",
    orgRole: "admin",
    orgSlug: TEST_ORG.slug,
    email: TEST_USER.email,
    expiresInSeconds: 300,
  });
  const claims = await verifyClerkJwt(token, env);
  assert(claims.sub);
  assert(claims.o);
  assert(claims.o.id);
  assert(claims.email);
  return {
    userId: TEST_USER.id,
    organizationId: TEST_ORG.id,
    role: "admin",
    permissions: getPermissionsForOrgRole("admin"),
    clerkUserId: claims.sub,
    clerkOrgId: claims.o.id,
    email: claims.email,
    orgSlug: TEST_ORG.slug,
    orgRole: "org:admin",
  };
}
