import type { DatabaseExecutor } from "@/db/client";

/**
 * Whether an organization withdrew its invitation to an address and has not
 * since issued a live one.
 *
 * Clerk mints the acceptance link for an invitation and we cannot expire it, so
 * revoking locally does not take the link out of circulation. Both places that
 * provision a membership from Clerk — the webhook sync and the login path —
 * consult this so a withdrawn invitation cannot still be redeemed.
 *
 * Three cases deliberately do not count as a refusal:
 *
 * - **No invitation at all.** Members added straight from the Clerk dashboard
 *   never have one, and blocking them would break that path entirely.
 * - **A live pending invitation.** A newer grant supersedes the withdrawal, so
 *   re-inviting a previously revoked address works.
 * - **An accepted or expired newest record.** Neither is a withdrawal.
 */
export async function invitationWasRevoked(
  db: DatabaseExecutor,
  organizationId: string,
  email: string,
  options: { lock?: boolean } = {}
): Promise<boolean> {
  const normalizedEmail = email.toLowerCase();

  if (options.lock) {
    // Reading the status and writing the membership are separate statements, so
    // a revocation committing between them would otherwise still admit the
    // member. Locking every invitation row for this address makes the two
    // orderings the only possible ones: the revocation waits for this caller to
    // finish, or it lands first and is seen below. Requires an open transaction.
    await db
      .prepare(
        `SELECT id
           FROM invitations
          WHERE organization_id = ? AND email = ?
          FOR UPDATE`
      )
      .bind(organizationId, normalizedEmail)
      .all();
  }

  const livePendingInvite = await db
    .prepare(
      `SELECT id
         FROM invitations
        WHERE organization_id = ? AND email = ? AND status = 'pending' AND expires_at > ?
        LIMIT 1`
    )
    .bind(organizationId, normalizedEmail, new Date().toISOString())
    .first<{ id: string }>();

  if (livePendingInvite) {
    return false;
  }

  const latest = await db
    .prepare(
      `SELECT status
         FROM invitations
        WHERE organization_id = ? AND email = ?
        ORDER BY created_at DESC
        LIMIT 1`
    )
    .bind(organizationId, normalizedEmail)
    .first<{ status: string }>();

  return latest?.status === "revoked";
}

/**
 * Revokes every pending invitation an organization holds for any address the
 * user is known by (their `users` email and every auth identity email).
 *
 * A pending invitation that survives a removal is a self-reinstatement token:
 * admission reactivates a removed member through a live invitation. Every path
 * that removes a member runs this in the same transaction as the status flip,
 * as its first statement, so locks are taken in admission's order (invitation,
 * then member).
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
