import type { InvitationStatus, OrganizationRole } from "@sdp/types";
import type { DatabaseClient } from "@/db";
import type { Organization, User } from "@/test/helpers/factories";

export interface InvitationSeed {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  invitedBy: string;
  status: InvitationStatus;
  expiresAt: string;
  /** Orders invitations for the newest-invitation reads; `YYYY-MM-DD HH:MM:SS`. */
  createdAt: string;
  acceptedAt: string | null;
}

export interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  status: string;
  accepted_at: string | null;
}

/**
 * Inserts organizations and users built by the shared factories, in one batch.
 *
 * @param db - Test database client.
 * @param params - Rows to insert.
 * @param params.organizations - Organizations to insert.
 * @param params.users - Users to insert.
 * @returns Resolves once every row is inserted.
 */
export async function seedOrganizationsAndUsers(
  db: DatabaseClient,
  params: { organizations: readonly Organization[]; users: readonly User[] }
): Promise<void> {
  await db.batch([
    ...params.organizations.map((organization) =>
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(
          organization.id,
          organization.name,
          organization.slug,
          organization.tier,
          organization.status
        )
    ),
    ...params.users.map((user) =>
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(user.id, user.email, user.emailVerified ? 1 : 0, user.status)
    ),
  ]);
}

/**
 * Inserts invitation rows, each with a token hash derived from its id.
 *
 * @param db - Test database client.
 * @param invitations - Invitations to insert.
 * @returns Resolves once every row is inserted.
 */
export async function seedInvitations(
  db: DatabaseClient,
  invitations: readonly InvitationSeed[]
): Promise<void> {
  await db.batch(
    invitations.map((invitation) =>
      db
        .prepare(
          `INSERT INTO invitations
             (id, organization_id, email, role, invited_by, token_hash, expires_at, status, created_at, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          invitation.id,
          invitation.organizationId,
          invitation.email,
          invitation.role,
          invitation.invitedBy,
          `hash_${invitation.id}`,
          invitation.expiresAt,
          invitation.status,
          invitation.createdAt,
          invitation.acceptedAt
        )
    )
  );
}

/**
 * Reads every invitation row, ordered by id.
 *
 * @param db - Test database client.
 * @returns The invitation rows.
 */
export async function readInvitations(db: DatabaseClient): Promise<InvitationRow[]> {
  return db.queryMany<InvitationRow>(
    "SELECT id, organization_id, email, role, status, accepted_at FROM invitations ORDER BY id"
  );
}
