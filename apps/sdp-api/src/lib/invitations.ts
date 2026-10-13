import type { DatabaseExecutor } from "@/db/client";

/**
 * Revokes every pending invitation an organization holds for any address the
 * user is known by (their `users` email and every auth identity email).
 *
 * A pending invitation that survives a removal is a self-reinstatement token:
 * admission reactivates a removed member through a live invitation. Every path
 * that removes a member runs this in the same transaction as the status flip,
 * as its first statement, so locks are taken in admission's order (invitations,
 * then the membership).
 *
 * @param tx - Open transaction the removal runs in
 * @param organizationId - Organization whose invitations are revoked
 * @param userId - SDP user being removed
 * @returns Resolves once the invitations are revoked
 */
export async function revokePendingInvitationsForUser(
  tx: DatabaseExecutor,
  organizationId: string,
  userId: string
): Promise<void> {
  await tx
    .prepare(
      `UPDATE invitations SET status = 'revoked'
        WHERE organization_id = ? AND status = 'pending'
          AND LOWER(email) IN (
            SELECT LOWER(email) FROM users WHERE id = ?
            UNION
            SELECT LOWER(email) FROM auth_user_identities WHERE user_id = ? AND email IS NOT NULL
          )`
    )
    .bind(organizationId, userId, userId)
    .run();
}

/**
 * Revokes the pending invitations every organization holds for any address the
 * user is known by, for user deletion. Same address set as
 * {@link revokePendingInvitationsForUser}.
 *
 * @param tx - Open transaction the deletion runs in
 * @param userId - SDP user being deleted
 * @returns Resolves once the invitations are revoked
 */
export async function revokePendingInvitationsForDeletedUser(
  tx: DatabaseExecutor,
  userId: string
): Promise<void> {
  await tx
    .prepare(
      `UPDATE invitations SET status = 'revoked'
        WHERE status = 'pending'
          AND LOWER(email) IN (
            SELECT LOWER(email) FROM users WHERE id = ?
            UNION
            SELECT LOWER(email) FROM auth_user_identities WHERE user_id = ? AND email IS NOT NULL
          )`
    )
    .bind(userId, userId)
    .run();
}

/**
 * Revokes every pending invitation an organization holds, for organization deletion.
 *
 * @param tx - Open transaction the deletion runs in
 * @param organizationId - Organization being deleted
 * @returns Resolves once the invitations are revoked
 */
export async function revokePendingInvitationsForOrganization(
  tx: DatabaseExecutor,
  organizationId: string
): Promise<void> {
  await tx
    .prepare(
      "UPDATE invitations SET status = 'revoked' WHERE organization_id = ? AND status = 'pending'"
    )
    .bind(organizationId)
    .run();
}
