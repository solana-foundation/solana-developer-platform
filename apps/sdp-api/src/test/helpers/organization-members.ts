import type { OrganizationRole } from "@sdp/types/roles";
import type { DatabaseClient } from "@/db/client";

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

/** Seeds an active organization, its users, and their active memberships. */
export async function seedOrganizationMembers(
  db: DatabaseClient,
  input: {
    organization: { id: string; slug: string };
    members: readonly SeededOrganizationMember[];
  }
): Promise<void> {
  const { organization, members } = input;
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(organization.id, organization.slug, organization.slug),
    ...members.flatMap((member) => [
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(member.userId, member.email),
      db
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, ?, 'active')`
        )
        .bind(member.memberId, organization.id, member.userId, member.role),
    ]),
  ]);
}
