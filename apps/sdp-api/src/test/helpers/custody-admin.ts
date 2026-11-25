import type { OrganizationTier } from "@sdp/types/organizations";
import { getDb } from "@/db/client";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { seedOrganizationMembers } from "@/test/helpers/organization-members";
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
  await seedOrganizationMembers(db, {
    organization: {
      id: scope.organizationId,
      slug: scope.organizationId.replaceAll("_", "-"),
      tier: scope.tier,
    },
    members: [
      {
        memberId: `mem_${scope.userId}`,
        userId: scope.userId,
        email: `${scope.userId}@example.com`,
        role: "admin",
      },
    ],
  });
  await seedDefaultProjects(db, {
    organizationId: scope.organizationId,
    createdBy: scope.userId,
    members: [scope.userId],
    ids: { sandbox: scope.projectId, production: `${scope.projectId}_production` },
  });
  const token = await signSeededClerkMember(env, db, scope.userId, scope.organizationId);
  // Verifying once fetches Clerk's signing keys into the process cache, so a
  // suite that later stubs global fetch does not answer the JWKS request itself.
  await verifyClerkJwt(token, env);
  return token;
}
