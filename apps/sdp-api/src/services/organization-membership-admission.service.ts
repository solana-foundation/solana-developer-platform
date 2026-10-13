import {
  type InvitationStatus,
  type LegacyOrganizationRole,
  type MemberStatus,
  normalizeOrganizationRole,
  type OrganizationRole,
  type OrganizationStatus,
} from "@sdp/types";
import type { DatabaseClient, DatabaseExecutor } from "@/db/client";

export type MembershipAdmission =
  | { admitted: true; role: OrganizationRole; joined: boolean }
  | {
      admitted: false;
      reason: "organization_deleted" | "user_deleted" | "membership_removed" | "invitation_revoked";
    };

interface InvitationRow {
  id: string;
  role: LegacyOrganizationRole;
  status: InvitationStatus;
  expires_at: string;
}

/**
 * Decides, in one transaction, whether a Clerk-verified user holds a membership
 * in an SDP organization, and writes the join when they may have one.
 *
 * This is the only path that creates or reactivates a membership; the login
 * path and the Clerk webhooks both call it, so a lost or late webhook changes
 * nothing about who gets in. Clerk answers only whether the user is a member;
 * the role is SDP's. The rules:
 *
 * - A deleted organization admits nobody, and a deleted user joins nothing:
 *   a Clerk session token can outlive the account it was issued for.
 * - An active member stays as they are.
 * - A removed member returns only through a live SDP invitation, which is
 *   claimed. Every removal revokes the member's pending invitations in the
 *   same transaction, so a live one is a re-invite issued after the removal.
 * - Anyone else joins, unless their newest invitation was revoked and no live
 *   one replaced it.
 *
 * A join through an invitation takes the invited role. A join without one (the
 * organization's creator) starts at the Clerk role.
 *
 * Locks are taken in one order: the organization row (FOR NO KEY UPDATE, which
 * leaves foreign-key inserts elsewhere unblocked), so admissions into one
 * organization serialize with each other and with its deletion; then the user
 * row (FOR SHARE), so a user deletion either lands first and is seen here or
 * waits; then every invitation row for the address, so a revocation either
 * lands first and is seen here or waits; then the membership row.
 *
 * @param db - Database client the transaction runs on
 * @param params - The organization, user and roles to admit
 * @param params.organizationId - SDP organization id
 * @param params.userId - SDP user id
 * @param params.email - The user's verified email, the key invitations match on
 * @param params.clerkRole - The user's verified Clerk organization role, the starting role of a join without an invitation
 * @returns The admitted role and whether this call created or reactivated the membership, or the refusal reason
 */
export async function admitOrganizationMember(
  db: DatabaseClient,
  params: {
    organizationId: string;
    userId: string;
    email: string;
    clerkRole: OrganizationRole;
  }
): Promise<MembershipAdmission> {
  const email = params.email.toLowerCase();

  return db.transaction(async (tx) => {
    const organization = await tx
      .prepare("SELECT status FROM organizations WHERE id = ? FOR NO KEY UPDATE")
      .bind(params.organizationId)
      .first<{ status: OrganizationStatus }>();
    if (!organization || organization.status === "deleted") {
      return { admitted: false, reason: "organization_deleted" };
    }

    const user = await tx
      .prepare("SELECT status FROM users WHERE id = ? FOR SHARE")
      .bind(params.userId)
      .first<{ status: string }>();
    if (!user || user.status === "deleted") {
      return { admitted: false, reason: "user_deleted" };
    }

    const invitations = await tx
      .prepare(
        `SELECT id, role, status, expires_at
           FROM invitations
          WHERE organization_id = ? AND email = ?
          ORDER BY created_at DESC
          FOR UPDATE`
      )
      .bind(params.organizationId, email)
      .all<InvitationRow>();
    const invitation = await liveInvitation(tx, invitations.results);

    const existing = await tx
      .prepare(
        `SELECT role, status
           FROM organization_members
          WHERE organization_id = ? AND user_id = ?
          FOR UPDATE`
      )
      .bind(params.organizationId, params.userId)
      .first<{ role: LegacyOrganizationRole; status: MemberStatus }>();

    if (existing?.status === "active") {
      return { admitted: true, role: normalizeOrganizationRole(existing.role), joined: false };
    }

    if (existing && !invitation) {
      return { admitted: false, reason: "membership_removed" };
    }

    if (!existing && !invitation && invitations.results[0]?.status === "revoked") {
      return { admitted: false, reason: "invitation_revoked" };
    }

    const role = invitation ? normalizeOrganizationRole(invitation.role) : params.clerkRole;
    if (invitation) {
      await acceptInvitation(tx, invitation.id);
    }
    if (existing) {
      await tx
        .prepare(
          `UPDATE organization_members
              SET status = 'active', role = ?
            WHERE organization_id = ? AND user_id = ? AND status = ?`
        )
        .bind(role, params.organizationId, params.userId, existing.status)
        .run();
    } else {
      await tx
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, ?, 'active')`
        )
        .bind(newMembershipId(), params.organizationId, params.userId, role)
        .run();
    }
    return { admitted: true, role, joined: true };
  });
}

/**
 * Returns the newest pending invitation when it is still live, marking it
 * expired instead when its window has passed.
 *
 * @param tx - Open transaction holding the invitation locks
 * @param invitations - The address's locked invitations, newest first
 * @returns The live invitation, or null
 */
async function liveInvitation(
  tx: DatabaseExecutor,
  invitations: InvitationRow[]
): Promise<InvitationRow | null> {
  const pending = invitations.find((invitation) => invitation.status === "pending");
  if (!pending) {
    return null;
  }
  if (new Date(pending.expires_at) < new Date()) {
    await tx
      .prepare("UPDATE invitations SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .bind(pending.id)
      .run();
    return null;
  }
  return pending;
}

/**
 * Marks a locked pending invitation accepted.
 *
 * @param tx - Open transaction holding the invitation lock
 * @param invitationId - Invitation to accept
 * @returns Resolves once the row is updated
 */
async function acceptInvitation(tx: DatabaseExecutor, invitationId: string): Promise<void> {
  await tx
    .prepare(
      `UPDATE invitations
          SET status = 'accepted', accepted_at = datetime('now')
        WHERE id = ? AND status = 'pending'`
    )
    .bind(invitationId)
    .run();
}

/** Mints an organization membership id. */
function newMembershipId(): string {
  return `mem_${crypto.randomUUID()}`;
}
