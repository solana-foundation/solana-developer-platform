import { hashString } from "@sdp/payments/hash";
import { normalizeOrganizationRole, type OrganizationRole, type Permission } from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import {
  type ClerkOrganizationInvitation,
  ClerkOrganizationsService,
} from "@/services/clerk-organizations.service";
import { SessionService } from "@/services/session.service";
import type { Env } from "@/types/env";
import { acceptSchema, inviteSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

function resolveActor(c: AppContext): {
  organizationId: string;
  userId: string | null;
  apiKeyId: string | null;
} {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return {
      organizationId: apiKey.organizationId,
      userId: null,
      apiKeyId: apiKey.id,
    };
  }

  const clerk = c.get("clerk");
  if (clerk) {
    return {
      organizationId: clerk.organizationId,
      userId: clerk.userId,
      apiKeyId: null,
    };
  }

  const session = c.get("session");
  if (session) {
    return {
      organizationId: session.organizationId,
      userId: session.userId,
      apiKeyId: null,
    };
  }

  throw new AppError("UNAUTHORIZED", "Authentication required");
}

/**
 * Whether the caller holds a permission, resolved exactly as
 * `requirePermissions` resolves it (same credential precedence, same wildcard).
 *
 * A route gate is all-or-nothing, so a response that mixes two sensitivities
 * has to check the finer one itself. Reading it the same way keeps the
 * in-handler gate from drifting away from the route-level one.
 */
function callerHasPermission(c: AppContext, permission: Permission): boolean {
  const permissions =
    c.get("apiKey")?.permissions ??
    c.get("clerk")?.permissions ??
    c.get("session")?.permissions ??
    null;

  if (!permissions) {
    return false;
  }

  return permissions.includes("*") || permissions.includes(permission);
}

function mapRoleToClerkRole(role: OrganizationRole): string {
  if (role === "admin") {
    return "org:admin";
  }
  return "org:member";
}

async function getClerkOrgId(db: DatabaseClient, organizationId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT provider_org_id
       FROM auth_organization_identities
       WHERE provider = 'clerk' AND organization_id = ?`
    )
    .bind(organizationId)
    .first<{ provider_org_id: string }>();

  return row?.provider_org_id ?? null;
}

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
 * Clerk user id of any active administrator of the organisation.
 *
 * Clerk requires a `requesting_user_id` to revoke an invitation, and the more
 * specific sources can all come up empty: an API key carries no Clerk user of
 * its own, `invited_by` may be the `"system"` sentinel with no identity row,
 * and Clerk's own `inviter_id` is optional on its invitation object. An
 * administrator is entitled to revoke, so attributing it to one keeps the
 * revocation possible rather than failing it. The local audit trail still
 * records the real actor; this only decides who Clerk is told asked.
 */
async function getAnyOrgAdminClerkUserId(
  db: DatabaseClient,
  organizationId: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT i.provider_user_id
         FROM organization_members m
         JOIN auth_user_identities i
           ON i.user_id = m.user_id AND i.provider = 'clerk'
        WHERE m.organization_id = ? AND m.role = 'admin' AND m.status = 'active'
        ORDER BY m.user_id
        LIMIT 1`
    )
    .bind(organizationId)
    .first<{ provider_user_id: string }>();

  return row?.provider_user_id ?? null;
}

function resolveInviteRedirectUrl(env: Env): string | undefined {
  const base = env.FRONTEND_URL?.replace(/\/$/, "");
  if (!base) {
    return undefined;
  }
  // Members live on the settings page. /members only redirects there, so
  // pointing at it made every accepted invite take an extra hop.
  return `${base}/dashboard/settings`;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  const globalWithBuffer = globalThis as {
    Buffer?: {
      from: (input: Uint8Array) => { toString: (encoding: "base64") => string };
    };
  };

  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Predicate that picks the Clerk invitation a local row stands for.
 *
 * Clerk's invitation id is the only unique key. Email is shared by every
 * pending invitation raised for the same address, so matching on it cannot tell
 * a second invitation for that address apart from ours — which is what let an
 * ambiguous revocation response read someone else's live invitation as proof
 * that ours survived.
 *
 * Rows written before the id was persisted have no better key available and
 * fall back to email. That is why revocation acts on *every* email match rather
 * than the first: it cannot identify which one is ours, so the invariant it
 * enforces is that none survive.
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

export const listMembers = async (c: AppContext) => {
  const { organizationId, userId: actorUserId } = resolveActor(c);
  const { page, pageSize } = resolveMembersPaging(c);

  // Pending invitations are shown only to callers who can act on them. Raising
  // one (`POST /invite`) and withdrawing one (`DELETE /invitations/:id`) both
  // require `org:write`, but this list is `org:read`, which the `member` role
  // holds too. That gap put every invitee's address — and Clerk's accept link,
  // a forwardable credential we cannot expire, since Clerk mints it — within
  // reach of the lowest privilege tier. The roster stays at `org:read`; the
  // invitations follow the permission that already governs them.
  const canReadInvitations = callerHasPermission(c, "org:write");

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
      // A misconfigured Clerk JWT template stored an unsubstituted placeholder as
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

  // Clerk mints the accept link and we only keep a hash of our own token, so
  // the shareable URL has to come from Clerk. Delivery of the invitation email
  // is not observable from here, so surfacing the link is the only way an
  // admin can unblock someone whose mail never arrived. Skipped when this page
  // carries no invitations, so listing members never waits on Clerk for links
  // nobody asked for.
  const clerkInvitations =
    invitationRows.results.length > 0 ? await resolveClerkInvitations(c, organizationId) : [];

  const invitationList = invitationRows.results.map((row) => ({
    id: row.id,
    email: row.email,
    role: normalizeOrganizationRole(row.role),
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    // Matched by Clerk's invitation id, so two pending invitations for the same
    // address each surface their own link rather than both showing whichever
    // one an email-keyed lookup happened to land on.
    acceptUrl: clerkInvitations.find(matchesClerkInvitation(row))?.url ?? null,
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

/**
 * Best-effort lookup of Clerk's pending invitations, which carry the accept
 * URLs. A Clerk outage must not take the member list down with it, so a failure
 * degrades to no links rather than an error.
 */
async function resolveClerkInvitations(
  c: AppContext,
  organizationId: string
): Promise<ClerkOrganizationInvitation[]> {
  try {
    const clerkOrgId = await getClerkOrgId(getDb(c.env), organizationId);
    if (!clerkOrgId) {
      return [];
    }

    const clerkService = new ClerkOrganizationsService(c.env);
    return await clerkService.listPendingOrganizationInvitations(clerkOrgId);
  } catch (error) {
    getLogger().error(
      {
        requestId: c.get("requestId"),
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      },
      "listMembers: failed to resolve Clerk invitation URLs"
    );
    return [];
  }
}

export const inviteMember = async (c: AppContext) => {
  const { organizationId, userId, apiKeyId } = resolveActor(c);
  const clerk = c.get("clerk");

  const body = await c.req.json();
  const parsed = inviteSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const { email } = parsed.data;
  const role = normalizeOrganizationRole(parsed.data.role);
  const normalizedEmail = email.toLowerCase().trim();
  const clerkRole = mapRoleToClerkRole(role);

  // Check if user already exists and is a member
  const existingMember = await getDb(c.env)
    .prepare(
      `SELECT om.id FROM organization_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.organization_id = ? AND u.email = ? AND om.status = 'active'`
    )
    .bind(organizationId, normalizedEmail)
    .first();

  if (existingMember) {
    throw new AppError("CONFLICT", "User is already a member of this organization");
  }

  // Check for pending invitation
  const existingInvite = await getDb(c.env)
    .prepare(
      `SELECT id FROM invitations
     WHERE organization_id = ? AND email = ? AND status = 'pending'`
    )
    .bind(organizationId, normalizedEmail)
    .first();

  if (existingInvite) {
    throw new AppError("CONFLICT", "Invitation already sent to this email");
  }

  if (!clerk?.clerkUserId) {
    throw new AppError("UNAUTHORIZED", "Clerk user required to send invites");
  }

  const clerkOrgId = await getClerkOrgId(getDb(c.env), organizationId);
  if (!clerkOrgId) {
    throw badRequest("Organization is not linked to Clerk");
  }

  const inviterKey =
    apiKeyId !== null
      ? await getDb(c.env)
          .prepare("SELECT created_by FROM api_keys WHERE id = ?")
          .bind(apiKeyId)
          .first<{ created_by: string }>()
      : null;

  const inviterUserId = userId || inviterKey?.created_by || null;

  const clerkService = new ClerkOrganizationsService(c.env);
  const redirectUrl = resolveInviteRedirectUrl(c.env);
  const clerkInvitation = await clerkService.createOrganizationInvitation({
    organizationId: clerkOrgId,
    inviterUserId: clerk.clerkUserId,
    emailAddress: normalizedEmail,
    role: clerkRole,
    redirectUrl,
    publicMetadata: {
      sdpRole: role,
      sdpOrganizationId: organizationId,
    },
  });

  // Create local invitation record for role mapping
  const invitationId = `inv_${crypto.randomUUID()}`;
  const token = randomBase64Url(32);
  const tokenHash = await hashString(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  // Clerk's invitation id is stored, not just audited. It is the only key that
  // identifies exactly one pending Clerk invitation — email is shared by every
  // invitation raised for the same address — and revocation depends on it to
  // avoid acting on, or drawing conclusions from, somebody else's invitation.
  await getDb(c.env)
    .prepare(
      `INSERT INTO invitations (id, organization_id, email, role, invited_by, token_hash, expires_at, status, clerk_invitation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .bind(
      invitationId,
      organizationId,
      normalizedEmail,
      role,
      inviterUserId || "system",
      tokenHash,
      expiresAt,
      clerkInvitation.id
    )
    .run();

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "invite",
    resourceType: "invitation",
    resourceId: invitationId,
    metadata: {
      email: normalizedEmail,
      role,
      clerkInvitationId: clerkInvitation.id,
      clerkRole,
    },
    organizationId: organizationId,
    userId: inviterUserId || undefined,
    apiKeyId: apiKeyId || undefined,
  });

  const response = {
    invitation: {
      id: invitationId,
      email: normalizedEmail,
      role,
      expiresAt,
      clerkInvitationId: clerkInvitation.id,
    },
    ...(c.env.ENVIRONMENT === "development" && { token }),
  };

  return created(c, response);
};

export const acceptInvitation = async (c: AppContext) => {
  const body = await c.req.json();
  const parsed = acceptSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const { token, name } = parsed.data;
  const tokenHash = await hashString(token);

  // Get invitation
  const invitation = await getDb(c.env)
    .prepare(
      `SELECT id, organization_id, email, role, expires_at, status
     FROM invitations
     WHERE token_hash = ?`
    )
    .bind(tokenHash)
    .first<{
      id: string;
      organization_id: string;
      email: string;
      role: string;
      expires_at: string;
      status: string;
    }>();

  if (!invitation) {
    throw new AppError("INVALID_INVITATION", "Invalid invitation token");
  }

  if (invitation.status !== "pending") {
    throw new AppError("INVALID_INVITATION", "Invitation is no longer valid");
  }

  if (new Date(invitation.expires_at) < new Date()) {
    throw new AppError("EXPIRED_INVITATION", "Invitation has expired");
  }

  // Claim the invitation and create the membership in one transaction.
  //
  // The status check above is only a read, so on its own it leaves a window in
  // which a concurrent revocation — or a second acceptance — can act on a row
  // this request still believes is pending. The conditional write below closes
  // that: exactly one caller flips pending to accepted.
  //
  // It has to commit together with the user and membership inserts, though.
  // Claiming first and failing afterwards would consume the invitation without
  // producing a membership, and the retry would be rejected as no longer valid
  // — stranding an invitee holding a token that is still rightfully theirs.
  await getDb(c.env).transaction(async (tx) => {
    const claimed = await tx
      .prepare(
        `UPDATE invitations
            SET status = 'accepted', accepted_at = datetime('now')
          WHERE id = ? AND status = 'pending'`
      )
      .bind(invitation.id)
      .run();

    if (claimed === 0) {
      throw new AppError("INVALID_INVITATION", "Invitation is no longer valid");
    }

    let user = await tx
      .prepare("SELECT id, email FROM users WHERE email = ?")
      .bind(invitation.email)
      .first<{ id: string; email: string }>();

    if (!user) {
      const userId = `usr_${crypto.randomUUID()}`;
      await tx
        .prepare(
          `INSERT INTO users (id, email, name, email_verified, status)
             VALUES (?, ?, ?, 1, 'active')`
        )
        .bind(userId, invitation.email, name ?? null)
        .run();

      user = { id: userId, email: invitation.email };
    }

    await tx
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(
        `mem_${crypto.randomUUID()}`,
        invitation.organization_id,
        user.id,
        normalizeOrganizationRole(invitation.role)
      )
      .run();
  });

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "accept_invite",
    resourceType: "invitation",
    resourceId: invitation.id,
    metadata: { email: invitation.email },
  });

  return success(c, { success: true });
};

export const removeMember = async (c: AppContext) => {
  const { memberId } = c.req.param();
  const { organizationId, userId, apiKeyId } = resolveActor(c);

  // Ensure member belongs to same org
  const member = await getDb(c.env)
    .prepare(
      `SELECT id, user_id, role, status
         FROM organization_members
        WHERE id = ? AND organization_id = ?`
    )
    .bind(memberId, organizationId)
    .first<{ id: string; user_id: string; role: string; status: string }>();

  if (!member) {
    throw notFound("Member");
  }

  if (member.status !== "active") {
    throw badRequest("Member has already been removed");
  }

  // Removing yourself revokes your own sessions mid-request and, for a sole
  // admin, leaves the organization with nobody able to administer it.
  if (userId && member.user_id === userId) {
    throw badRequest("You cannot remove yourself from the organization");
  }

  const removesAnAdmin = normalizeOrganizationRole(member.role) === "admin";

  await getDb(c.env).transaction(async (tx) => {
    if (removesAnAdmin) {
      // Lock every active admin row before counting them. A conditional UPDATE
      // is not enough on its own: it only locks the row it writes, so under
      // READ COMMITTED two concurrent removals of *different* admins each
      // evaluate the count against the pre-removal state, both see more than
      // one, and the organization is left with none. Locking the counted set
      // makes the second removal block here and re-read after the first
      // commits, at which point it correctly sees itself as the last admin.
      const admins = await tx
        .prepare(
          `SELECT id
             FROM organization_members
            WHERE organization_id = ? AND status = 'active' AND role = 'admin'
              FOR UPDATE`
        )
        .bind(organizationId)
        .all<{ id: string }>();

      const remainingAdmins = admins.results.filter((row) => row.id !== memberId);
      if (remainingAdmins.length === 0) {
        throw badRequest("The last admin cannot be removed");
      }
    }

    const removal = await tx
      .prepare(
        `UPDATE organization_members
            SET status = 'removed'
          WHERE id = ? AND status = 'active'`
      )
      .bind(memberId)
      .run();

    // run() resolves to the affected-row count, so a zero means the row stopped
    // being active between the check above and this write.
    if (removal === 0) {
      throw badRequest("Member has already been removed");
    }
  });

  // Clerk drives sign-in, so leaving the membership there would keep the
  // organization visible in its switcher even though our API rejects it.
  await removeClerkMembership(c, organizationId, member.user_id).catch((error) =>
    getLogger().error({ error }, "Failed to remove Clerk membership after member removal")
  );

  const sessionService = new SessionService(getDb(c.env));
  await sessionService
    .revokeUserOrganizationSessions(member.user_id, organizationId)
    .catch((error) =>
      getLogger().error({ error }, "Failed to revoke sessions after member removal")
    );

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "delete",
    resourceType: "member",
    resourceId: memberId,
    metadata: { userId: member.user_id },
    organizationId,
    userId: userId || undefined,
    apiKeyId: apiKeyId || undefined,
  });

  return noContent(c);
};

/**
 * Whether Clerk received a revocation call and refused it outright.
 *
 * The service surfaces the HTTP status on the error details, so a 4xx means
 * Clerk answered and declined to act — the invitation is still live there.
 * 404 is deliberately excluded: it means the invitation no longer exists in
 * Clerk, so the local row should stay revoked rather than be reopened.
 */
function clerkDefinitivelyRefused(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  const status = error.details?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 404;
}

export const revokeInvitation = async (c: AppContext) => {
  const { invitationId } = c.req.param();
  const { organizationId, userId, apiKeyId } = resolveActor(c);

  const invitation = await getDb(c.env)
    .prepare(
      `SELECT id, email, status, invited_by, clerk_invitation_id
         FROM invitations
        WHERE id = ? AND organization_id = ?`
    )
    .bind(invitationId, organizationId)
    .first<{
      id: string;
      email: string;
      status: string;
      invited_by: string;
      clerk_invitation_id: string | null;
    }>();

  // Scoped by organization so an id from another org reads as missing rather
  // than as a permission failure.
  if (!invitation) {
    throw notFound("Invitation");
  }

  if (invitation.status !== "pending") {
    throw badRequest("Only a pending invitation can be revoked");
  }

  // Claim the row before calling Clerk. Revoking in Clerk first leaves a window
  // in which an acceptance consumes the still-pending local token and creates a
  // membership that the local update below never removes, leaving the invitee
  // active against a revoked invitation. A conditional write closes that window.
  const claimed = await getDb(c.env)
    .prepare("UPDATE invitations SET status = 'revoked' WHERE id = ? AND status = 'pending'")
    .bind(invitation.id)
    .run();

  if (claimed === 0) {
    throw badRequest("Only a pending invitation can be revoked");
  }

  let clerkRevocationAttempted = false;
  let clerkService: ClerkOrganizationsService | null = null;
  let clerkOrgId: string | null = null;

  try {
    const clerk = c.get("clerk");
    clerkOrgId = await getClerkOrgId(getDb(c.env), organizationId);
    if (!clerkOrgId) {
      throw badRequest("Organization is not linked to Clerk");
    }

    clerkService = new ClerkOrganizationsService(c.env);
    const pending = await clerkService.listPendingOrganizationInvitations(clerkOrgId);

    // Keyed on Clerk's invitation id, so exactly the invitation this row stands
    // for is revoked. Legacy rows without that id fall back to email and match
    // every invitation for the address — see matchesClerkInvitation.
    const matches = pending.filter(matchesClerkInvitation(invitation));

    for (const match of matches) {
      // An API key has no Clerk user of its own. Clerk's own inviter_id is the
      // most reliable fallback: it is a valid Clerk user by construction, so it
      // holds even when invited_by has no matching auth_user_identities row.
      // `||` rather than `??` on purpose: Clerk returns `inviter_id` as an
      // empty string rather than omitting it when an invitation has no inviter,
      // and an empty id is as unusable as a missing one.
      const requestingUserId =
        clerk?.clerkUserId ||
        match.inviter_id ||
        (await getClerkUserId(getDb(c.env), invitation.invited_by)) ||
        // Last resort so an invitation is never unrevokable: any active admin
        // is entitled to revoke, and Clerk demands some requesting user.
        (await getAnyOrgAdminClerkUserId(getDb(c.env), organizationId));

      if (!requestingUserId) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Cannot revoke this invitation: no Clerk user is available to attribute the revocation to"
        );
      }

      clerkRevocationAttempted = true;
      await clerkService.revokeOrganizationInvitation({
        organizationId: clerkOrgId,
        invitationId: match.id,
        requestingUserId,
      });
    }
  } catch (error) {
    // Release the claim only when the invitation is known to still be live in
    // Clerk, because Clerk mints the acceptance link and recording a revocation
    // we did not carry out there would leave the invite redeemable while we
    // report it revoked.
    const releaseClaim = async () => {
      await getDb(c.env)
        .prepare("UPDATE invitations SET status = 'pending' WHERE id = ? AND status = 'revoked'")
        .bind(invitation.id)
        .run();
    };

    if (!clerkRevocationAttempted || clerkDefinitivelyRefused(error)) {
      // Never asked, or asked and refused outright: nothing was revoked there.
      await releaseClaim();
    } else if (clerkService && clerkOrgId) {
      // A transport failure or 5xx says nothing about whether Clerk applied the
      // revocation. Rather than guess, ask: if the invitation is still pending
      // there, the revocation did not take effect and the local row has to
      // follow it back to pending. This is what keeps the two from diverging
      // into a live acceptance link recorded locally as revoked.
      //
      // Matched on Clerk's invitation id, so a different invitation raised for
      // the same address cannot be mistaken for ours and reopen a token that
      // was in fact revoked.
      //
      // If the verification itself also fails, the claim stays. The two doors
      // are not equally ours: a live Clerk invitation provisions a membership
      // through clerk-auth whatever this row says (`clerk-auth.ts:236` falls
      // back to the Clerk role when no pending invitation is found), so
      // reopening the row does not close that one. The local token is the door
      // we do control, and reopening it would leave a credential we issued
      // redeemable after a revocation that may well have succeeded. Keeping the
      // claim gives up nothing we could have protected and keeps that credential
      // dead. The admin still learns the attempt failed — this path throws.
      const stillPendingInClerk = await clerkService
        .listPendingOrganizationInvitations(clerkOrgId)
        .then((entries) => entries.some(matchesClerkInvitation(invitation)))
        .catch(() => false);

      if (stillPendingInClerk) {
        await releaseClaim();
      }
    }

    throw error;
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "revoke",
    resourceType: "invitation",
    resourceId: invitation.id,
    metadata: { email: invitation.email },
    organizationId,
    userId: userId || undefined,
    apiKeyId: apiKeyId || undefined,
  });

  return noContent(c);
};

/**
 * Mirrors a removal into Clerk. Best effort: our own membership row is already
 * the gate that clerk-auth enforces, so a Clerk failure must not fail the
 * removal and leave the two out of step in the other direction.
 */
async function removeClerkMembership(
  c: AppContext,
  organizationId: string,
  userId: string
): Promise<void> {
  const clerkOrgId = await getClerkOrgId(getDb(c.env), organizationId);
  if (!clerkOrgId) {
    return;
  }

  const clerkUserId = await getClerkUserId(getDb(c.env), userId);
  if (!clerkUserId) {
    return;
  }

  await new ClerkOrganizationsService(c.env).deleteOrganizationMembership({
    organizationId: clerkOrgId,
    userId: clerkUserId,
  });
}
