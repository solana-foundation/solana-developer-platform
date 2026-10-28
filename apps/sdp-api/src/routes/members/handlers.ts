import { INVITATION_STATUSES } from "@sdp/types/organizations";
import { normalizeOrganizationRole } from "@sdp/types/roles";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { createOrganizationRepository } from "@/db/repositories/repository-factory";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  notFound,
  unauthorized,
} from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { getAuthorized } from "@/middleware/authorize";
import { requireHumanActor } from "@/middleware/human-session";
import { callerMayPerform } from "@/middleware/require-action";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import { findClerkOrganizationId } from "@/services/clerk-organization-provisioning.service";
import {
  type ClerkOrganizationInvitation,
  ClerkOrganizationsService,
} from "@/services/clerk-organizations.service";
import {
  applyMembershipChange,
  findPendingInvitation,
  type MembershipChange,
} from "@/services/organization-membership.service";
import type { Env } from "@/types/env";
import type { inviteSchema, updateMemberRoleSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

/** The signed-in person; the router refuses API keys first (HOO-2099). */
function resolveActor(c: AppContext): { organizationId: string; userId: string } {
  const clerk = requireHumanActor(c);
  return { organizationId: clerk.organizationId, userId: clerk.userId };
}

const seatCountSchema = z.object({ taken: z.coerce.number() });
const invitationStatusSchema = z.object({ status: z.enum(INVITATION_STATUSES) });

/** How long an invitation admits its address, in SDP and in Clerk's link alike. */
const INVITATION_TTL_DAYS = 7;

/**
 * Members an organization may hold, pending invitations included, as Clerk
 * counts its own membership limit: refusing here spends no Clerk call.
 */
const MAX_ORGANIZATION_MEMBERS = 20;

/** Clerk user id for an SDP user, or null when they have no Clerk identity. */
async function getClerkUserId(db: DatabaseClient, userId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT provider_user_id
         FROM auth_user_identities
        WHERE provider = 'clerk' AND user_id = ?`
    )
    .bind(userId)
    .first<{ provider_user_id: string }>();

  return row?.provider_user_id ?? null;
}

/**
 * Where Clerk's invitation link lands: the dashboard's sign-in page, whose
 * Clerk component reads the ticket from its own URL and signs the invitee in,
 * or sends a new person on to sign up with it. A protected page would bounce
 * the invitee to sign-in with the ticket buried in a redirect parameter.
 * Without a dashboard URL Clerk would fall back to its own hosted pages, so the
 * invite is refused instead.
 *
 * @param env - The environment.
 * @returns The sign-in URL on the dashboard's origin.
 */
function resolveInviteRedirectUrl(env: Env): string {
  if (!env.FRONTEND_URL) {
    throw internalError("FRONTEND_URL is required to send invitations");
  }
  return `${new URL(env.FRONTEND_URL).origin}/sign-in`;
}

/**
 * Predicate that picks the Clerk invitations a local row stands for.
 *
 * Clerk's invitation id is the only key that identifies exactly one. A row
 * without it is one whose Clerk call failed before the id was recorded, so any
 * Clerk invitation it created can only be found by address: every pending one
 * for that address matches, and revocation takes them all.
 */
function matchesClerkInvitation(invitation: {
  email: string;
  clerk_invitation_id: string | null;
}): (entry: ClerkOrganizationInvitation) => boolean {
  const clerkInvitationId = invitation.clerk_invitation_id;

  if (clerkInvitationId) {
    return (entry) => entry.id === clerkInvitationId;
  }

  const email = invitation.email.toLowerCase();
  return (entry) => entry.email_address?.toLowerCase() === email;
}

const MEMBERS_DEFAULT_PAGE_SIZE = 25;
const MEMBERS_MAX_PAGE_SIZE = 100;

function resolveMembersPaging(c: AppContext): { page: number; pageSize: number } {
  const rawPage = Number.parseInt(c.req.query("page") ?? "", 10);
  const rawPageSize = Number.parseInt(c.req.query("pageSize") ?? "", 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize =
    Number.isFinite(rawPageSize) && rawPageSize > 0
      ? Math.min(rawPageSize, MEMBERS_MAX_PAGE_SIZE)
      : MEMBERS_DEFAULT_PAGE_SIZE;

  return { page, pageSize };
}

/** A pending invitation as stored locally, before Clerk's accept link is joined on. */
interface PendingInvitationRow {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  expires_at: string;
  clerk_invitation_id: string | null;
}

export const getCurrentMember = async (c: AppContext) => {
  const { organizationId, userId } = resolveActor(c);
  const member = await createOrganizationRepository(c.env).findActiveMember({
    organizationId,
    userId,
  });
  if (!member) {
    throw unauthorized("Organization membership is inactive");
  }
  return success(c, { memberId: member.memberId, userId, organizationId, role: member.role });
};

export const listMembers = async (c: AppContext) => {
  const { organizationId, userId: actorUserId } = resolveActor(c);
  const { page, pageSize } = resolveMembersPaging(c);

  // Pending invitations are shown only to callers who can act on them. Raising
  // one (`POST /invite`) and withdrawing one (`DELETE /invitations/:id`) both
  // require `members.manage`, but this list is `members.read`, which the
  // `member` role holds too. That gap put every invitee's address — and
  // Clerk's accept link, a forwardable credential we cannot expire, since
  // Clerk mints it — within reach of the lowest privilege tier. The roster
  // stays at `members.read`; the invitations follow the action that already
  // governs them. A route gate is all-or-nothing, so the finer check is here.
  const canReadInvitations = callerMayPerform(c, "members.manage");

  const memberTotalRow = await getDb(c.env)
    .prepare(
      `SELECT COUNT(*) as total
         FROM organization_members
        WHERE organization_id = ? AND status = 'active'`
    )
    .bind(organizationId)
    .first<{ total: number }>();
  const memberTotal = Number(memberTotalRow?.total ?? 0);

  // One cutoff for both the count and the slice below. Reading the clock twice
  // lets an invitation expire between them, which shifts the window the offset
  // is measured against and can skip or repeat a row.
  const now = new Date().toISOString();

  const invitationTotalRow = canReadInvitations
    ? await getDb(c.env)
        .prepare(
          `SELECT COUNT(*) as total
             FROM invitations
            WHERE organization_id = ? AND status = 'pending' AND expires_at > ?`
        )
        .bind(organizationId, now)
        .first<{ total: number }>()
    : null;
  const invitationTotal = Number(invitationTotalRow?.total ?? 0);

  const offset = (page - 1) * pageSize;

  const results = await getDb(c.env)
    .prepare(
      // A misconfigured Clerk token customization stored an unsubstituted placeholder as
      // the email. Sign-in repairs `auth_user_identities` (its upsert overwrites the
      // email) but never `users`, whose insert is ON CONFLICT DO NOTHING — so the
      // directory kept showing the placeholder until a deploy re-ran migration 0040.
      // Preferring a clean identity email makes a re-login enough on its own.
      // The subselect avoids multiplying rows when a user holds more than one
      // identity for the provider.
      //
      // "Usable" is migration 0040's own test, both halves of it: not a placeholder
      // AND shaped like an address. Excluding only `{{` still let values like
      // `unknown` or a bare id through, so the endpoint emitted something its own
      // repair rule does not consider an email. The final `u.email` stays as a last
      // resort — a row where nothing is usable has to return the stored value rather
      // than NULL, and the caller decides how to render it.
      `SELECT om.id, om.role, om.status, om.created_at,
            u.id as user_id, u.name,
            COALESCE(
              NULLIF(
                CASE
                  WHEN u.email NOT LIKE '%{{%' AND u.email LIKE '%@%.%' THEN u.email
                  ELSE ''
                END, ''),
              (SELECT aui.email
                 FROM auth_user_identities aui
                WHERE aui.user_id = u.id
                  AND aui.provider = 'clerk'
                  AND aui.email IS NOT NULL
                  AND aui.email NOT LIKE '%{{%'
                  AND aui.email LIKE '%@%.%'
                ORDER BY aui.updated_at DESC NULLS LAST
                LIMIT 1),
              u.email
            ) AS email
     FROM organization_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.organization_id = ? AND om.status = 'active'
     ORDER BY om.created_at ASC
     LIMIT ? OFFSET ?`
    )
    .bind(organizationId, pageSize, offset)
    .all();

  const memberList = results.results.map((row) => ({
    id: row.id as string,
    role: normalizeOrganizationRole(row.role as string),
    status: row.status as string,
    createdAt: row.created_at as string,
    // The caller cannot reliably work this out: it holds emails, not the
    // actor's user id, and matching on email is the wrong key.
    isSelf: Boolean(actorUserId) && row.user_id === actorUserId,
    user: {
      id: row.user_id as string,
      email: row.email as string,
      name: row.name as string | null,
    },
  }));

  // Invitations are returned alongside members because an invited person is
  // otherwise invisible: they hold no organization_members row until they
  // accept, so sending an invite appeared to do nothing. Expired ones are
  // excluded — they cannot be accepted, so listing them only misleads.
  //
  // Members and invitations are one directory rendered as one table, so they
  // page as one sequence: the invitations take whatever room on this page the
  // member rows leave, and their own offset resumes where the members ran out.
  // Querying them unsliced instead repeated the entire set on every page.
  const invitationLimit = Math.max(0, pageSize - memberList.length);
  const invitationOffset = Math.max(0, offset - memberTotal);

  const invitationRows =
    canReadInvitations && invitationLimit > 0
      ? await getDb(c.env)
          .prepare(
            `SELECT id, email, role, status, created_at, expires_at, clerk_invitation_id
         FROM invitations
        WHERE organization_id = ? AND status = 'pending' AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`
          )
          .bind(organizationId, now, invitationLimit, invitationOffset)
          .all<PendingInvitationRow>()
      : { results: [] as PendingInvitationRow[] };

  // Clerk's accept link is never returned: its ticket signs an existing Clerk
  // user in as the invitee, so whoever reads it, the inviting admin included,
  // could take over the invitee's account. Only the invitee's inbox receives it.
  const invitationList = invitationRows.results.map((row) => ({
    id: row.id,
    email: row.email,
    role: normalizeOrganizationRole(row.role),
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));

  const adminCountRow = await getDb(c.env)
    .prepare(
      `SELECT COUNT(*) as total
         FROM organization_members
        WHERE organization_id = ? AND status = 'active' AND role = 'admin'`
    )
    .bind(organizationId)
    .first<{ total: number }>();

  return success(c, {
    members: memberList,
    invitations: invitationList,
    meta: {
      // Counts the whole directory this caller can see, members and pending
      // invitations together, because they page as one sequence. A caller
      // without `org:write` sees no invitations, so for them it is the member
      // count — which keeps hasMore and the page count honest for both.
      total: memberTotal + invitationTotal,
      page,
      pageSize,
      hasMore: page * pageSize < memberTotal + invitationTotal,
      // Counted across the organization, not the page, so the last-admin rule
      // is right even when admins fall on a page the caller is not viewing.
      activeAdminCount: Number(adminCountRow?.total ?? 0),
    },
  });
};

export const inviteMember = async (c: ValidatedBodyContext<typeof inviteSchema>) => {
  const { organizationId, userId } = resolveActor(c);

  const body = c.req.valid("json");
  const role = normalizeOrganizationRole(body.role);
  const normalizedEmail = body.email.toLowerCase().trim();

  const existingMember = await getDb(c.env)
    .prepare(
      `SELECT om.id FROM organization_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.organization_id = ? AND u.email = ? AND om.status = 'active'`
    )
    .bind(organizationId, normalizedEmail)
    .first();

  if (existingMember) {
    throw conflict("User is already a member of this organization");
  }

  const clerkOrgId = await findClerkOrganizationId(getDb(c.env), organizationId);
  if (!clerkOrgId) {
    throw badRequest("Organization is not linked to Clerk");
  }

  const redirectUrl = resolveInviteRedirectUrl(c.env);
  const invitationId = `inv_${crypto.randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // The SDP invitation is the claim (ADR 0012): its INSERT decides concurrent
  // invites to one address on idx_invitations_one_pending_per_email, so the
  // loser spends no Clerk call. A pending row past its expiry no longer
  // admits anyone, so it gives the address up first. The organization row is
  // locked before the seat count, so concurrent invites cannot both take the
  // last seat; it locks before invitations, the order admission takes them.
  try {
    await new AuditService(getDb(c.env)).logWithin(c, async (tx) => {
      await tx
        .prepare("SELECT id FROM organizations WHERE id = ? FOR UPDATE")
        .bind(organizationId)
        .first();
      await tx
        .prepare(
          `UPDATE invitations SET status = 'expired'
            WHERE organization_id = ? AND LOWER(email) = ? AND status = 'pending' AND expires_at <= ?`
        )
        .bind(organizationId, normalizedEmail, now.toISOString())
        .run();
      const seats = await tx
        .prepare(
          `SELECT (SELECT COUNT(*) FROM organization_members
                    WHERE organization_id = ? AND status = 'active')
                + (SELECT COUNT(*) FROM invitations
                    WHERE organization_id = ? AND status = 'pending' AND expires_at > ?) AS taken`
        )
        .bind(organizationId, organizationId, now.toISOString())
        .first<Record<string, unknown>>();
      if (seatCountSchema.parse(seats).taken >= MAX_ORGANIZATION_MEMBERS) {
        throw conflict(
          `The organization has reached its limit of ${MAX_ORGANIZATION_MEMBERS} members, pending invitations included`
        );
      }
      await tx
        .prepare(
          `INSERT INTO invitations (id, organization_id, email, role, invited_by, token_hash, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
        )
        .bind(
          invitationId,
          organizationId,
          normalizedEmail,
          role,
          userId,
          // Nothing redeems a token since the accept route went; the NOT NULL
          // UNIQUE column takes the invitation id until the cleanup migration drops it.
          invitationId,
          expiresAt
        )
        .run();
      return {
        entry: {
          action: "invite",
          resourceType: "invitation",
          resourceId: invitationId,
          metadata: { email: normalizedEmail, role },
          organizationId,
          userId,
        },
        result: undefined,
      };
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw conflict("Invitation already sent to this email");
    }
    throw error;
  }

  const clerk = new ClerkOrganizationsService(c.env);
  const clerkInvitation = await clerk.createOrganizationInvitation({
    organizationId: clerkOrgId,
    emailAddress: normalizedEmail,
    expiresInDays: INVITATION_TTL_DAYS,
    redirectUrl,
  });

  // Clerk's invitation id is the only key that identifies exactly one pending
  // Clerk invitation, so revocation acts on it rather than on the address. A
  // revocation that committed while Clerk was inviting found nothing to revoke
  // there, so the invitation it just created is withdrawn here.
  const recorded = await getDb(c.env)
    .prepare(
      `UPDATE invitations SET clerk_invitation_id = ?
        WHERE id = ? AND organization_id = ? AND status = 'pending' AND clerk_invitation_id IS NULL`
    )
    .bind(clerkInvitation.id, invitationId, organizationId)
    .run();
  // A sign-in can also accept the invitation while Clerk is inviting (a Clerk
  // membership that survived a failed removal names the organization): the
  // person joined, so the invite succeeded.
  if (recorded === 0) {
    const current = invitationStatusSchema.parse(
      await getDb(c.env)
        .prepare("SELECT status FROM invitations WHERE id = ? AND organization_id = ?")
        .bind(invitationId, organizationId)
        .first<Record<string, unknown>>()
    );
    if (current.status !== "accepted") {
      await clerk.revokeOrganizationInvitation({
        organizationId: clerkOrgId,
        invitationId: clerkInvitation.id,
      });
      throw conflict("The invitation was revoked while it was being sent");
    }
  }

  return created(c, {
    invitation: {
      id: invitationId,
      email: normalizedEmail,
      role,
      expiresAt,
      clerkInvitationId: clerkInvitation.id,
    },
  });
};

export const updateMemberRole = async (c: ValidatedBodyContext<typeof updateMemberRoleSchema>) => {
  const { organizationId, userId } = resolveActor(c);
  const { id: memberId } = getAuthorized<{ id: string }>(c);
  const { role } = c.req.valid("json");

  const updated = await new AuditService(getDb(c.env)).logWithin(c, async (tx) => {
    const change = await applyMembershipChange(tx, {
      organizationId,
      actorUserId: userId,
      change: { kind: "set_role", memberId, role },
    });
    return {
      entry: change.changed
        ? {
            action: "update",
            resourceType: "member",
            resourceId: change.memberId,
            metadata: { userId: change.userId, previousRole: change.previousRole, role },
            organizationId,
            userId,
          }
        : null,
      result: change,
    };
  });

  return success(c, { memberId: updated.memberId, userId: updated.userId, organizationId, role });
};

/**
 * The role change and remove routes' access check: the member belongs to the caller's
 * organization. Scoped by organization, so an id from another one reads as
 * missing rather than as a permission failure.
 *
 * @param c - The request context.
 * @returns The member's id.
 */
export async function authorizeOrganizationMember(c: AppContext): Promise<{ id: string }> {
  const { memberId } = c.req.param();
  const { organizationId } = resolveActor(c);
  const member = await getDb(c.env)
    .prepare("SELECT id FROM organization_members WHERE id = ? AND organization_id = ?")
    .bind(memberId, organizationId)
    .first<{ id: string }>();
  if (!member) {
    throw notFound("Member");
  }
  return member;
}

export const removeMember = async (c: AppContext) => {
  const { organizationId, userId } = resolveActor(c);
  const member = getAuthorized<{ id: string }>(c);

  const removed = await endMembership(c, {
    organizationId,
    actorUserId: userId,
    change: { kind: "remove", memberId: member.id },
  });
  // A retry of a finished removal must not take the Clerk membership of a
  // person re-invited since: accepting that invitation gave it back to them.
  if (!removed.changed && (await holdsPendingInvitation(c, organizationId, removed.userId))) {
    return noContent(c);
  }
  await removeClerkMembership(c, organizationId, removed.userId);
  return noContent(c);
};

export const leaveOrganization = async (c: AppContext) => {
  const { organizationId, userId } = resolveActor(c);

  // Leaving cannot be retried: the next request of someone who left is
  // refused at sign-in. A failed Clerk call still fails the request; the Clerk
  // membership it leaves behind admits no one (ADR 0012).
  const left = await endMembership(c, {
    organizationId,
    actorUserId: userId,
    change: { kind: "leave" },
  });
  await removeClerkMembership(c, organizationId, left.userId);
  return noContent(c);
};

/**
 * Ends a membership by removal or leaving and records it in one transaction.
 * A removal retried after its Clerk half failed changes and records nothing.
 *
 * @param c - The request context.
 * @param params.organizationId - The organization.
 * @param params.actorUserId - The caller.
 * @param params.change - The removal or the leave.
 * @returns The ended membership.
 */
async function endMembership(
  c: AppContext,
  params: {
    organizationId: string;
    actorUserId: string;
    change: Extract<MembershipChange, { kind: "remove" | "leave" }>;
  }
): Promise<{ memberId: string; userId: string; changed: boolean }> {
  return new AuditService(getDb(c.env)).logWithin(c, async (tx) => {
    const ended = await applyMembershipChange(tx, params);
    return {
      entry: ended.changed
        ? {
            action: "delete",
            resourceType: "member",
            resourceId: ended.memberId,
            metadata: { userId: ended.userId, left: params.change.kind === "leave" },
            organizationId: params.organizationId,
            userId: params.actorUserId,
          }
        : null,
      result: { memberId: ended.memberId, userId: ended.userId, changed: ended.changed },
    };
  });
}

/**
 * Whether the person holds a pending invitation to the organization.
 *
 * @param c - The request context.
 * @param organizationId - The organization.
 * @param userId - The person.
 * @returns True when an invitation to their address is pending.
 */
async function holdsPendingInvitation(
  c: AppContext,
  organizationId: string,
  userId: string
): Promise<boolean> {
  const user = await getDb(c.env)
    .prepare("SELECT email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string }>();
  if (!user) {
    throw notFound("User");
  }
  return (
    (await findPendingInvitation(getDb(c.env), { organizationId, email: user.email })) !== null
  );
}

/** An invitation of the caller's organization, as the revoke route's access check loads it. */
export interface OrganizationInvitation {
  id: string;
  email: string;
  clerk_invitation_id: string | null;
}

/**
 * The revoke route's access check: the invitation belongs to the caller's
 * organization. Scoped by organization, so an id from another one reads as
 * missing rather than as a permission failure.
 *
 * @param c - The request context.
 * @returns The invitation.
 */
export async function authorizeOrganizationInvitation(
  c: AppContext
): Promise<OrganizationInvitation> {
  const { invitationId } = c.req.param();
  const { organizationId } = resolveActor(c);
  const invitation = await getDb(c.env)
    .prepare(
      `SELECT id, email, clerk_invitation_id
         FROM invitations
        WHERE id = ? AND organization_id = ?`
    )
    .bind(invitationId, organizationId)
    .first<OrganizationInvitation>();
  if (!invitation) {
    throw notFound("Invitation");
  }
  return invitation;
}

export const revokeInvitation = async (c: AppContext) => {
  const { organizationId, userId } = resolveActor(c);
  const invitation = getAuthorized<OrganizationInvitation>(c);

  // SDP revokes first (ADR 0012): sign-in admits only from a pending SDP
  // invitation, so the revoked row keeps the person out whatever Clerk still
  // holds. An invitation already revoked is a retry whose Clerk half failed,
  // so only that half runs again.
  const revokedNow = await new AuditService(getDb(c.env)).logWithin(c, async (tx) => {
    const revoked = await tx
      .prepare(
        `UPDATE invitations SET status = 'revoked'
          WHERE id = ? AND organization_id = ? AND status = 'pending'`
      )
      .bind(invitation.id, organizationId)
      .run();
    if (revoked === 0) {
      const current = await tx
        .prepare("SELECT status FROM invitations WHERE id = ? AND organization_id = ?")
        .bind(invitation.id, organizationId)
        .first<Record<string, unknown>>();
      if (invitationStatusSchema.parse(current).status !== "revoked") {
        throw badRequest("Only a pending invitation can be revoked");
      }
      return { entry: null, result: false };
    }
    return {
      entry: {
        action: "revoke",
        resourceType: "invitation",
        resourceId: invitation.id,
        metadata: { email: invitation.email },
        organizationId,
        userId,
      },
      result: true,
    };
  });

  // A row with no Clerk id is matched by address, which is safe only while it
  // is the address's one pending invitation: on a retry a newer invitation may
  // hold the address, so only a stored Clerk id is acted on.
  if (!revokedNow && invitation.clerk_invitation_id === null) {
    return noContent(c);
  }
  await revokeClerkInvitations(c, organizationId, invitation);
  return noContent(c);
};

/**
 * Revokes the Clerk invitations an SDP invitation stands for that are still
 * pending in Clerk. Asking Clerk which are pending first makes a retry after a
 * partial failure revoke only what is left.
 *
 * @param c - The request context.
 * @param organizationId - The SDP organization.
 * @param invitation - The revoked SDP invitation.
 */
async function revokeClerkInvitations(
  c: AppContext,
  organizationId: string,
  invitation: OrganizationInvitation
): Promise<void> {
  const clerkOrgId = await findClerkOrganizationId(getDb(c.env), organizationId);
  if (!clerkOrgId) {
    throw badRequest("Organization is not linked to Clerk");
  }
  // A Clerk invitation another SDP invitation recorded is that invitation's,
  // even when its address matches a row with no Clerk id of its own.
  const recorded = await getDb(c.env)
    .prepare(
      `SELECT clerk_invitation_id FROM invitations
        WHERE organization_id = ? AND id <> ? AND clerk_invitation_id IS NOT NULL`
    )
    .bind(organizationId, invitation.id)
    .all<{ clerk_invitation_id: string }>();
  const othersRecorded = new Set(recorded.results.map((row) => row.clerk_invitation_id));
  // A row with no Clerk id matches by address, which is only safe while no
  // other SDP invitation holds the address: a newer one may have created its
  // Clerk invitation and not yet recorded the id.
  if (invitation.clerk_invitation_id === null) {
    const newer = await findPendingInvitation(getDb(c.env), {
      organizationId,
      email: invitation.email,
    });
    if (newer !== null) {
      return;
    }
  }
  const clerkService = new ClerkOrganizationsService(c.env);
  const pending = await clerkService.listPendingOrganizationInvitations(clerkOrgId);
  const ours = pending
    .filter(matchesClerkInvitation(invitation))
    .filter((entry) => !othersRecorded.has(entry.id));
  for (const match of ours) {
    await clerkService.revokeOrganizationInvitation({
      organizationId: clerkOrgId,
      invitationId: match.id,
    });
  }
}

/**
 * Mirrors a committed removal into Clerk, so the organization leaves the
 * person's Clerk switcher. A membership Clerk no longer has is already removed
 * there, which is what a retry finds once the first attempt got through.
 *
 * @param c - The request context.
 * @param organizationId - The SDP organization.
 * @param userId - The SDP user whose membership ended.
 */
async function removeClerkMembership(
  c: AppContext,
  organizationId: string,
  userId: string
): Promise<void> {
  const clerkOrgId = await findClerkOrganizationId(getDb(c.env), organizationId);
  if (!clerkOrgId) {
    throw badRequest("Organization is not linked to Clerk");
  }
  // A person who never signed in through Clerk holds no Clerk membership.
  const clerkUserId = await getClerkUserId(getDb(c.env), userId);
  if (!clerkUserId) {
    return;
  }
  try {
    await new ClerkOrganizationsService(c.env).deleteOrganizationMembership({
      organizationId: clerkOrgId,
      userId: clerkUserId,
    });
  } catch (error) {
    if (error instanceof AppError && error.details?.status === 404) {
      return;
    }
    throw error;
  }
}
