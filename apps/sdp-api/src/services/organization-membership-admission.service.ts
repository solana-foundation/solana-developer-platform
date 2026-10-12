import { normalizeOrganizationRole, type OrganizationRole } from "@sdp/types";
import type { DatabaseExecutor } from "@/db/client";
import { invitationWasRevoked } from "@/lib/invitations";

export type MembershipAdmission =
  | { admitted: true; role: OrganizationRole; joined: boolean }
  | {
      admitted: false;
      reason: "organization_deleted" | "membership_removed" | "invitation_revoked";
    };

/**
 * Decides, in one transaction, whether a Clerk-verified user holds a membership
 * in an SDP organization, and writes the join when they may have one.
 *
 * This is the only path that creates or reactivates a membership from Clerk
 * state; the login path and the Clerk webhooks both call it, so a lost or late
 * webhook changes nothing about who gets in. The rules:
 *
 * - A deleted organization admits nobody.
 * - An active member stays as they are. A live invitation still pending for
 *   them is marked accepted, so the directory stops listing it.
 * - A removed member returns only through a live SDP invitation, which is
 *   claimed and decides their role. Neither a sign-in nor a webhook alone
 *   reactivates them.
 * - Anyone else joins with the live invitation's role, else the Clerk role,
 *   unless their newest invitation was revoked.
 *
 * The organization row is locked first (FOR NO KEY UPDATE, which leaves
 * foreign-key inserts elsewhere unblocked), so admissions into one organization
 * serialize with each other and with its deletion. Every invitation row for
 * the address is locked next, so a revocation either lands first and is seen
 * here or waits for this transaction to commit.
 *
 * @param db - Database client the transaction runs on
 * @param params - The organization, user and roles to admit
 * @param params.organizationId - SDP organization id
 * @param params.userId - SDP user id
 * @param params.email - The user's verified email, the key invitations match on
 * @param params.clerkRole - The user's Clerk organization role, used when no live invitation names one
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
      .first<{ status: string }>();
    if (!organization || organization.status === "deleted") {
      return { admitted: false, reason: "organization_deleted" };
    }

    const revoked = await invitationWasRevoked(tx, params.organizationId, email, { lock: true });
    const invitation = await claimableInvitation(tx, params.organizationId, email);

    const existing = await tx
      .prepare(
        `SELECT role, status
           FROM organization_members
          WHERE organization_id = ? AND user_id = ?
          FOR UPDATE`
      )
      .bind(params.organizationId, params.userId)
      .first<{ role: string; status: string }>();

    if (existing?.status === "active") {
      if (invitation) {
        await acceptInvitation(tx, invitation.id, normalizeOrganizationRole(invitation.role));
      }
      return { admitted: true, role: normalizeOrganizationRole(existing.role), joined: false };
    }

    if (existing) {
      if (!invitation) {
        return { admitted: false, reason: "membership_removed" };
      }
      const role = normalizeOrganizationRole(invitation.role);
      await acceptInvitation(tx, invitation.id, role);
      await tx
        .prepare(
          `UPDATE organization_members
              SET status = 'active', role = ?
            WHERE organization_id = ? AND user_id = ?`
        )
        .bind(role, params.organizationId, params.userId)
        .run();
      return { admitted: true, role, joined: true };
    }

    if (!invitation && revoked) {
      return { admitted: false, reason: "invitation_revoked" };
    }

    const role = invitation ? normalizeOrganizationRole(invitation.role) : params.clerkRole;
    if (invitation) {
      await acceptInvitation(tx, invitation.id, role);
    }
    await tx
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(newMembershipId(), params.organizationId, params.userId, role)
      .run();
    return { admitted: true, role, joined: true };
  });
}

/**
 * Returns the newest pending invitation for the address when it is still live,
 * marking it expired instead when its window has passed. Must run after the
 * address's invitation rows are locked.
 *
 * @param tx - Open transaction holding the invitation locks
 * @param organizationId - SDP organization id
 * @param email - Lowercased invited address
 * @returns The live invitation, or null
 */
async function claimableInvitation(
  tx: DatabaseExecutor,
  organizationId: string,
  email: string
): Promise<{ id: string; role: string } | null> {
  const pending = await tx
    .prepare(
      `SELECT id, role, expires_at
         FROM invitations
        WHERE organization_id = ? AND email = ? AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1`
    )
    .bind(organizationId, email)
    .first<{ id: string; role: string; expires_at: string }>();
  if (!pending) {
    return null;
  }
  if (new Date(pending.expires_at) < new Date()) {
    await tx
      .prepare("UPDATE invitations SET status = 'expired' WHERE id = ?")
      .bind(pending.id)
      .run();
    return null;
  }
  return { id: pending.id, role: pending.role };
}

/**
 * Marks a locked pending invitation accepted with its normalized role.
 *
 * @param tx - Open transaction holding the invitation lock
 * @param invitationId - Invitation to accept
 * @param role - Normalized role recorded on the invitation
 * @returns Resolves once the row is updated
 */
async function acceptInvitation(
  tx: DatabaseExecutor,
  invitationId: string,
  role: OrganizationRole
): Promise<void> {
  await tx
    .prepare(
      `UPDATE invitations
          SET status = 'accepted', accepted_at = datetime('now'), role = ?
        WHERE id = ? AND status = 'pending'`
    )
    .bind(role, invitationId)
    .run();
}

/** Mints an organization membership id. */
function newMembershipId(): string {
  return `mem_${crypto.randomUUID()}`;
}
