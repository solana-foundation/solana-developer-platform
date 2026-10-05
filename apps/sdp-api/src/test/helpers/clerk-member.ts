import assert from "node:assert/strict";
import type { DatabaseClient } from "@/db";
import { ensureTestClerkIssuer, signTestClerkJwt } from "@/test/helpers/clerk";
import type { Env } from "@/types/env";

export async function signSeededClerkMember(
  env: Env,
  db: DatabaseClient,
  userId: string,
  organizationId: string
): Promise<string> {
  const member = await db.queryOne<{
    email: string;
    role: string;
    slug: string;
  }>(
    `SELECT u.email, m.role, o.slug FROM organization_members m
     JOIN users u ON u.id = m.user_id
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = ? AND m.organization_id = ? AND m.status = 'active'`,
    [userId, organizationId]
  );
  assert(member);
  assert(member.role === "admin" || member.role === "member");
  const clerkUserId = `clerk_user_${userId}`;
  const clerkOrgId = `clerk_org_${organizationId}`;
  await db.batch([
    db
      .prepare(`INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
      VALUES (?, 'clerk', ?, ?, ?)
      ON CONFLICT (provider, provider_user_id) DO UPDATE SET email = EXCLUDED.email`)
      .bind(`aui_test_${userId}`, clerkUserId, userId, member.email),
    db
      .prepare(`INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
      VALUES (?, 'clerk', ?, ?, ?)
      ON CONFLICT (provider, provider_org_id) DO UPDATE SET slug = EXCLUDED.slug`)
      .bind(`aoi_test_${organizationId}`, clerkOrgId, organizationId, member.slug),
  ]);
  await ensureTestClerkIssuer(env);
  return signTestClerkJwt({
    clerkUserId,
    clerkOrgId,
    orgRole: member.role,
    orgSlug: member.slug,
    email: member.email,
    expiresInSeconds: 300,
  });
}
