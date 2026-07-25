import type { DatabaseClient } from "@/db/client";

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
  db: DatabaseClient,
  organizationId: string,
  email: string
): Promise<boolean> {
  const normalizedEmail = email.toLowerCase();

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
