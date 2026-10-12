import assert from "node:assert/strict";
import type { InvitationStatus, OrganizationRole } from "@sdp/types";
import type { DatabaseClient } from "@/db";
import type { Organization, User } from "@/test/helpers/factories";

export interface InvitationSeed {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  invitedBy: string;
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: string;
  /** Orders invitations for the newest-invitation reads. */
  createdAt: string;
  acceptedAt: string | null;
  clerkInvitationId: string | null;
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
 * Inserts invitation rows in one batch.
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
             (id, organization_id, email, role, invited_by, token_hash, expires_at, status, created_at, accepted_at, clerk_invitation_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          invitation.id,
          invitation.organizationId,
          invitation.email,
          invitation.role,
          invitation.invitedBy,
          invitation.tokenHash,
          invitation.expiresAt,
          invitation.status,
          invitation.createdAt,
          invitation.acceptedAt,
          invitation.clerkInvitationId
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

/**
 * Flips one seeded membership to removed, as SDP member removal leaves it.
 *
 * @param db - Test database client.
 * @param params - The membership to remove.
 * @param params.organizationId - Organization the member belongs to.
 * @param params.userId - SDP user whose membership is removed.
 * @returns Resolves once the membership is removed.
 */
export async function seedRemovedMember(
  db: DatabaseClient,
  params: { organizationId: string; userId: string }
): Promise<void> {
  const removed = await db
    .prepare(
      "UPDATE organization_members SET status = 'removed' WHERE organization_id = ? AND user_id = ?"
    )
    .bind(params.organizationId, params.userId)
    .run();
  assert.equal(removed, 1, "Expected one seeded membership to remove");
}
