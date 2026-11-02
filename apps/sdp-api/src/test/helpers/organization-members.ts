import type { OrganizationRole } from "@sdp/types/roles";
import type { DatabaseClient } from "@/db/client";
import { seedOrganization } from "@/test/helpers/organizations";

export interface SeededOrganizationMember {
  memberId: string;
  userId: string;
  email: string;
  role: OrganizationRole;
}

/** A member fixture whose ids and email derive from `key`. */
export function organizationMember(key: string, role: OrganizationRole): SeededOrganizationMember {
  return { memberId: `mem_${key}`, userId: `usr_${key}`, email: `${key}@example.com`, role };
}

/** Seeds an active organization created by its first member, its users, and their active memberships. */
export async function seedOrganizationMembers(
  db: DatabaseClient,
  input: {
    organization: { id: string; slug: string };
    members: readonly [SeededOrganizationMember, ...SeededOrganizationMember[]];
  }
): Promise<void> {
  const { organization, members } = input;
  const [creator] = members;
  await db.batch(members.map((member) => userStatement(db, member)));
  await seedOrganization(db, {
    id: organization.id,
    name: organization.slug,
    slug: organization.slug,
    status: "active",
    creator: { id: creator.userId, email: creator.email },
  });
  await db.batch(members.map((member) => membershipStatement(db, organization.id, member)));
}

/** Seeds users and their active memberships of an organization already seeded. */
export async function seedActiveMemberships(
  db: DatabaseClient,
  organizationId: string,
  members: readonly SeededOrganizationMember[]
): Promise<void> {
  await db.batch(
    members.flatMap((member) => [
      userStatement(db, member),
      membershipStatement(db, organizationId, member),
    ])
  );
}

function userStatement(db: DatabaseClient, member: SeededOrganizationMember) {
  return db
    .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
    .bind(member.userId, member.email);
}

function membershipStatement(
  db: DatabaseClient,
  organizationId: string,
  member: SeededOrganizationMember
) {
  return db
    .prepare(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status)
       VALUES (?, ?, ?, ?, 'active')`
    )
    .bind(member.memberId, organizationId, member.userId, member.role);
}
