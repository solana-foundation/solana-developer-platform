import { MEMBER_STATUSES } from "@sdp/types/organizations";
import { normalizeOrganizationRole, type OrganizationRole } from "@sdp/types/roles";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";
import { conflict, missingAction, notFound } from "@/lib/errors";

export type MembershipChange =
  | { kind: "set_role"; memberId: string; role: OrganizationRole }
  | { kind: "remove"; memberId: string }
  | { kind: "leave" };

const membershipTargetSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  status: z.enum(MEMBER_STATUSES),
});

const lockedMemberSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  role: z.string().transform(normalizeOrganizationRole),
  status: z.enum(MEMBER_STATUSES),
});

/**
 * Applies a role change, removal or leave to one membership, under the rules
 * every such change shares (ADR 0012): nobody changes their own role or
 * removes themselves, an admin cannot leave, and the organization always keeps
 * an active admin. Removal and leaving also revoke the person's pending
 * invitations and remove their project memberships. Removing a member already
 * removed changes nothing, so a retry can finish the removal's Clerk half.
 *
 * @param tx - An open transaction; the admin rows it locks are held until it ends.
 * @param params.organizationId - The caller's organization; the target must belong to it.
 * @param params.actorUserId - The caller, who is the target when leaving.
 * @param params.change - The change to apply.
 * @returns The target membership, its role before the change, and whether anything was written.
 */
export async function applyMembershipChange(
  tx: DatabaseExecutor,
  params: { organizationId: string; actorUserId: string; change: MembershipChange }
): Promise<{ memberId: string; userId: string; previousRole: OrganizationRole; changed: boolean }> {
  const { organizationId, actorUserId, change } = params;

  const targetRow =
    change.kind === "leave"
      ? await tx
          .prepare(
            "SELECT id, user_id, status FROM organization_members WHERE organization_id = ? AND user_id = ?"
          )
          .bind(organizationId, actorUserId)
          .first<Record<string, unknown>>()
      : await tx
          .prepare(
            "SELECT id, user_id, status FROM organization_members WHERE organization_id = ? AND id = ?"
          )
          .bind(organizationId, change.memberId)
          .first<Record<string, unknown>>();
  if (!targetRow) {
    throw notFound("Member");
  }
  const target = membershipTargetSchema.parse(targetRow);

  // Invitations lock before memberships, the order admission and organization
  // deletion take them. A pending invitation outliving a removal would readmit
  // the person at their next sign-in, so it is revoked in the same transaction.
  // A member already removed keeps any invitation raised since: retrying the
  // removal must not withdraw a later re-invite.
  if (change.kind !== "set_role" && target.status !== "removed") {
    await revokePendingInvitations(tx, organizationId, target.user_id);
  }

  // Locks the target, the caller and every active admin, in id order. Two
  // admins acting on each other serialize here, and the second decides against
  // the first's committed write rather than the state both read: whether the
  // organization keeps an admin, and whether the caller is still one.
  const locked = z.array(lockedMemberSchema).parse(
    (
      await tx
        .prepare(
          `SELECT id, user_id, role, status
             FROM organization_members
            WHERE organization_id = ?
              AND (id = ? OR user_id = ? OR (status = 'active' AND role = 'admin'))
            ORDER BY id
              FOR UPDATE`
        )
        .bind(organizationId, target.id, actorUserId)
        .all<Record<string, unknown>>()
    ).results
  );
  const member = locked.find((row) => row.id === target.id);
  if (!member) {
    throw notFound("Member");
  }
  // Removing a member already removed is a retry whose Clerk half failed: it
  // passes the caller's check below and then changes nothing.
  const retriedRemoval = change.kind === "remove" && member.status === "removed";
  if (member.status !== "active" && !retriedRemoval) {
    throw conflict("Member is not active");
  }

  // The caller's role was read when the request authenticated; a removal or
  // demotion committed since then ends their authority here, not a request later.
  if (change.kind !== "leave") {
    const actor = locked.find((row) => row.user_id === actorUserId);
    if (actor?.status !== "active" || actor.role !== "admin") {
      throw missingAction("members.manage");
    }
  }

  const isSelf = member.user_id === actorUserId;
  // The actor check above already leaves an active admin who is not the
  // target; the last-admin refusals below are kept as defense in depth.
  const otherActiveAdmins = locked.filter(
    (row) => row.id !== member.id && row.status === "active" && row.role === "admin"
  ).length;
  const result = { memberId: member.id, userId: member.user_id, previousRole: member.role };

  switch (change.kind) {
    case "set_role": {
      if (isSelf) {
        throw conflict("An admin cannot change their own role");
      }
      if (member.role === change.role) {
        return { ...result, changed: false };
      }
      if (member.role === "admin" && otherActiveAdmins === 0) {
        throw conflict("The last admin cannot be demoted");
      }
      await tx
        .prepare("UPDATE organization_members SET role = ? WHERE id = ?")
        .bind(change.role, member.id)
        .run();
      return { ...result, changed: true };
    }
    case "remove": {
      if (retriedRemoval) {
        return { ...result, changed: false };
      }
      if (isSelf) {
        throw conflict("You cannot remove yourself from the organization");
      }
      if (member.role === "admin" && otherActiveAdmins === 0) {
        throw conflict("The last admin cannot be removed");
      }
      await removeMembership(tx, organizationId, member);
      return { ...result, changed: true };
    }
    case "leave": {
      if (member.role === "admin") {
        throw conflict("An admin cannot leave the organization");
      }
      await removeMembership(tx, organizationId, member);
      return { ...result, changed: true };
    }
    default: {
      const exhaustive: never = change;
      throw new Error(`Unknown membership change: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Mirrors a membership Clerk no longer holds into SDP as a removal: an operator
 * deleted it in the Clerk Dashboard, or deleted the person's Clerk user
 * (ADR 0012). It only ever takes access away, and skips the actor and
 * last-admin rules because the operator already decided in Clerk. A membership
 * not yet removed ends with its project memberships, and the person's pending
 * invitations are revoked even when they were never admitted, so a deletion
 * before their first sign-in still keeps them out. A membership already removed
 * changes nothing: that is SDP's own removal coming back from Clerk, and an
 * invitation raised since must survive it. An active membership is removed
 * only if Clerk still lacks it once the row is locked: a re-admission that
 * committed after the caller's earlier Clerk read holds a new Clerk membership,
 * possibly under another Clerk user linked to the same person, and one that has
 * not committed waits behind the lock.
 *
 * @param tx - An open transaction.
 * @param params.organizationId - The organization.
 * @param params.userId - The person Clerk no longer lists.
 * @param params.heldInClerk - Reads, through the open transaction, whether Clerk lists the person in the organization now.
 * @returns The membership removed, or null when none was, and how many invitations were revoked.
 */
export async function mirrorClerkMembershipDeletion(
  tx: DatabaseExecutor,
  params: {
    organizationId: string;
    userId: string;
    heldInClerk: (tx: DatabaseExecutor) => Promise<boolean>;
  }
): Promise<{ removedMemberId: string | null; revokedInvitations: number }> {
  const { organizationId, userId } = params;

  const targetRow = await tx
    .prepare(
      "SELECT id, user_id, status FROM organization_members WHERE organization_id = ? AND user_id = ?"
    )
    .bind(organizationId, userId)
    .first<Record<string, unknown>>();
  const target = targetRow ? membershipTargetSchema.parse(targetRow) : null;
  if (target !== null && target.status === "removed") {
    return { removedMemberId: null, revokedInvitations: 0 };
  }

  // Invitations lock before memberships, the order admission takes them. The
  // membership is read again once locked even when none existed: a sign-in
  // holding the invitation may have admitted the person in between.
  const revokedInvitations = await revokePendingInvitations(tx, organizationId, userId);
  const lockedRow = await tx
    .prepare(
      "SELECT id, user_id, status FROM organization_members WHERE organization_id = ? AND user_id = ? FOR UPDATE"
    )
    .bind(organizationId, userId)
    .first<Record<string, unknown>>();
  if (!lockedRow) {
    return { removedMemberId: null, revokedInvitations };
  }
  const member = membershipTargetSchema.parse(lockedRow);
  if (member.status === "removed" || (await params.heldInClerk(tx))) {
    return { removedMemberId: null, revokedInvitations };
  }
  await removeMembership(tx, organizationId, member);
  return { removedMemberId: member.id, revokedInvitations };
}

const pendingInvitationSchema = z.object({
  id: z.string(),
  role: z.string().transform(normalizeOrganizationRole),
  expires_at: z.string(),
});

/**
 * The newest pending invitation of an address to the organization, the one
 * sign-in admits from (ADR 0012). Every read that decides whether a person
 * without an active membership may proceed goes through this, so they cannot
 * disagree.
 *
 * @param db - The database or open transaction.
 * @param params.organizationId - The organization.
 * @param params.email - The address, in any letter case.
 * @returns The invitation, expired or not, or null when there is none.
 */
export async function findPendingInvitation(
  db: DatabaseExecutor,
  params: { organizationId: string; email: string }
): Promise<{ id: string; role: OrganizationRole; expiresAt: string } | null> {
  const row = await db
    .prepare(
      `SELECT id, role, expires_at
         FROM invitations
        WHERE organization_id = ? AND LOWER(email) = ? AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1`
    )
    .bind(params.organizationId, params.email.toLowerCase())
    .first<Record<string, unknown>>();
  if (!row) {
    return null;
  }
  const invitation = pendingInvitationSchema.parse(row);
  return { id: invitation.id, role: invitation.role, expiresAt: invitation.expires_at };
}

/**
 * Revokes the person's pending invitations to the organization, matched on
 * every email SDP holds for them, since any of them could become the verified
 * email a later sign-in is admitted on.
 *
 * @param tx - The open transaction.
 * @param organizationId - The organization the invitations are for.
 * @param userId - The person being removed.
 * @returns How many invitations were revoked.
 */
async function revokePendingInvitations(
  tx: DatabaseExecutor,
  organizationId: string,
  userId: string
): Promise<number> {
  const emails = await personEmails(tx, userId);
  if (emails.length === 0) {
    return 0;
  }
  return tx
    .prepare(
      `UPDATE invitations SET status = 'revoked'
        WHERE organization_id = ? AND status = 'pending'
          AND LOWER(email) IN (${emails.map(() => "?").join(", ")})`
    )
    .bind(organizationId, ...emails)
    .run();
}

/**
 * Every organization a deleted Clerk user still reaches: one where their
 * membership is not removed, or one holding a pending invitation to any email
 * SDP has for them (someone deleted before their first sign-in).
 *
 * @param db - The database.
 * @param userId - The person.
 * @returns The organization ids.
 */
export async function organizationsReachingPerson(
  db: DatabaseExecutor,
  userId: string
): Promise<string[]> {
  const emails = await personEmails(db, userId);
  const invited =
    emails.length === 0
      ? ""
      : `UNION
         SELECT organization_id FROM invitations
          WHERE status = 'pending' AND LOWER(email) IN (${emails.map(() => "?").join(", ")})`;
  const rows = await db
    .prepare(
      `SELECT organization_id FROM organization_members WHERE user_id = ? AND status <> 'removed'
       ${invited}`
    )
    .bind(userId, ...emails)
    .all<{ organization_id: string }>();
  return rows.results.map((row) => row.organization_id);
}

/**
 * Every email SDP holds for the person, lowercased, since any of them could
 * become the verified email a later sign-in is admitted on.
 *
 * @param db - The database or open transaction.
 * @param userId - The person.
 * @returns The distinct addresses.
 */
async function personEmails(db: DatabaseExecutor, userId: string): Promise<string[]> {
  const emailRows = await db
    .prepare(
      `SELECT email FROM users WHERE id = ?
       UNION
       SELECT email FROM auth_user_identities WHERE user_id = ? AND email IS NOT NULL`
    )
    .bind(userId, userId)
    .all<{ email: string | null }>();
  return [
    ...new Set(
      emailRows.results
        .map((row) => row.email?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email))
    ),
  ];
}

/**
 * Ends the membership and the person's memberships of the organization's projects.
 * Project memberships end only with the organization membership and carry no
 * history of their own (the membership row and the audit log hold it), so they
 * are deleted rather than archived.
 *
 * @param tx - The open transaction.
 * @param organizationId - The organization.
 * @param member - The locked, active membership row.
 */
async function removeMembership(
  tx: DatabaseExecutor,
  organizationId: string,
  member: { id: string; user_id: string }
): Promise<void> {
  await tx
    .prepare("UPDATE organization_members SET status = 'removed' WHERE id = ?")
    .bind(member.id)
    .run();
  await tx
    .prepare(
      `DELETE FROM project_members pm
        USING projects p
        WHERE p.id = pm.project_id AND p.organization_id = ? AND pm.user_id = ?`
    )
    .bind(organizationId, member.user_id)
    .run();
}
