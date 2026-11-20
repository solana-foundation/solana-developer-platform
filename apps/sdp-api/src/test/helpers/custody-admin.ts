import type { OrganizationTier } from "@sdp/types/organizations";
import { getDb } from "@/db/client";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { seedDefaultProjects } from "@/test/helpers/projects";
import type { Env } from "@/types/env";

export interface CustodyAdminScope {
  organizationId: string;
  userId: string;
  /** The sandbox project; its production sibling is `${projectId}_production`. */
  projectId: string;
  tier: OrganizationTier;
}

/**
 * Seeds an active organization whose one user administers it and is a member of
 * its sandbox and production projects, then signs that user's Clerk session.
 *
 * @param env - The environment the token is signed and verified against.
 * @param scope - The organization, user and sandbox project to seed.
 * @returns The user's Clerk session token, for `Authorization: Bearer`.
 */
export async function seedCustodyAdmin(env: Env, scope: CustodyAdminScope): Promise<string> {
  const db = getDb(env);
  const slug = scope.organizationId.replaceAll("_", "-");
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, 'active')"
      )
      .bind(scope.organizationId, slug, slug, scope.tier),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(scope.userId, `${scope.userId}@example.com`),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind(`mem_${scope.userId}`, scope.organizationId, scope.userId),
  ]);
  await seedDefaultProjects(db, {
    organizationId: scope.organizationId,
    createdBy: scope.userId,
    members: [scope.userId],
    ids: { sandbox: scope.projectId, production: `${scope.projectId}_production` },
  });
  const token = await signSeededClerkMember(env, db, scope.userId, scope.organizationId);
  await verifyClerkJwt(token, env);
  return token;
}
