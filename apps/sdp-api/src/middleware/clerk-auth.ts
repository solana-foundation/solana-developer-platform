/**
 * Clerk Authentication Middleware (Option A)
 *
 * Verifies Clerk JWTs, maps external identities to internal users/orgs,
 * and sets a Clerk auth context for downstream handlers.
 */

import { normalizeOrganizationRole, type OrganizationRole } from "@sdp/types/roles";
import type { Context, ContextVariableMap, Next } from "hono";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db/identity";
import {
  type ClerkJwtPayload,
  extractBearerToken,
  isPlausibleEmail,
  resolveClerkEmail,
  resolveClerkOrganizationClaims,
  verifyClerkSessionToken,
} from "@/lib/clerk-token";
import { AppError, badRequest, internalError, unauthorized } from "@/lib/errors";
import { runAsMoneyPrincipal } from "@/lib/money-principal";
import { organizationNotActive, readActiveOrganizationSettings } from "@/lib/organization-access";
import { recordOrganizationEntitlements } from "@/lib/production-entitlement";
import { AuditService } from "@/services/audit.service";
import {
  ClerkUsersService,
  verifiedPrimaryEmailFromClerkUser,
} from "@/services/clerk-users.service";
import { findPendingInvitation } from "@/services/organization-membership.service";
import type { Env } from "@/types/env";
import { DASHBOARD_ACTOR_MAX_REQUESTS, enforceRateLimit } from "./rate-limit";

/**
 * The stored identity for a Clerk user, with both copies of the email.
 *
 * They are read separately rather than COALESCEd in SQL because either copy can hold an
 * unsubstituted JWT-template placeholder, and a plain COALESCE prefers whichever is
 * non-null — including the corrupted one. Which copy is good depends on the code path
 * that wrote the row, so the caller picks the first that is actually an address.
 */
async function resolveClerkUser(db: DatabaseClient, clerkUserId: string) {
  return db
    .prepare(
      `SELECT aui.user_id, aui.email AS identity_email, u.email AS user_email
       FROM auth_user_identities aui
       LEFT JOIN users u ON u.id = aui.user_id
       WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
    )
    .bind(clerkUserId)
    .first<{ user_id: string; identity_email: string | null; user_email: string | null }>();
}

async function resolveClerkOrganization(db: DatabaseClient, clerkOrgId: string) {
  return db
    .prepare(
      `SELECT organization_id, slug
       FROM auth_organization_identities
       WHERE provider = 'clerk' AND provider_org_id = ?`
    )
    .bind(clerkOrgId)
    .first<{ organization_id: string; slug: string | null }>();
}

/**
 * Both copies of the email are read separately here for the same reason as
 * {@link resolveClerkUser}: a COALESCE prefers whichever copy is non-null, and the
 * corrupted one is a placeholder string rather than a NULL. This is the path taken for an
 * established user, so it is the one a repaired database still has to keep clean.
 */
async function resolveExistingClerkContext(
  db: DatabaseClient,
  params: {
    clerkUserId: string;
    clerkOrgId: string;
    fallbackOrgSlug: string | null;
  }
) {
  return db
    .prepare(
      `SELECT
         aui.user_id,
         aui.email AS identity_email,
         u.email AS user_email,
         aoi.organization_id,
         COALESCE(aoi.slug, ?) AS org_slug,
         om.role
       FROM auth_organization_identities aoi
       LEFT JOIN auth_user_identities aui
         ON aui.provider = 'clerk' AND aui.provider_user_id = ?
       LEFT JOIN users u
         ON u.id = aui.user_id
       LEFT JOIN organization_members om
         ON om.user_id = aui.user_id
        AND om.organization_id = aoi.organization_id
        AND om.status = 'active'
       WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?
       LIMIT 1`
    )
    .bind(params.fallbackOrgSlug, params.clerkUserId, params.clerkOrgId)
    .first<{
      user_id: string | null;
      identity_email: string | null;
      user_email: string | null;
      organization_id: string;
      org_slug: string | null;
      role: string | null;
    }>();
}

async function resolveOrgMembership(db: DatabaseClient, userId: string, organizationId: string) {
  return db
    .prepare(
      `SELECT role, status
       FROM organization_members
       WHERE user_id = ? AND organization_id = ?`
    )
    .bind(userId, organizationId)
    .first<{ role: string; status: string }>();
}

/**
 * Writes a known-good email over a stored placeholder.
 *
 * Each copy is repaired only when it is actually broken, so a healthy row does no
 * writes. `users.email` is UNIQUE, so the update is skipped when another row already
 * holds the address — that is a merge decision, not a repair, and matches how
 * migration 0040 leaves colliding rows alone.
 */
async function repairClerkEmails(
  db: DatabaseClient,
  params: {
    userId: string;
    clerkUserId: string;
    email: string;
    identityEmail: string | null;
    userEmail: string | null;
  }
): Promise<void> {
  const { userId, clerkUserId, email, identityEmail, userEmail } = params;

  if (!isPlausibleEmail(userEmail)) {
    await db
      .prepare(
        `UPDATE users SET email = ?
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM users other WHERE other.email = ? AND other.id <> ?)`
      )
      .bind(email, userId, email, userId)
      .run();
  }

  if (!isPlausibleEmail(identityEmail)) {
    await db
      .prepare(
        `UPDATE auth_user_identities SET email = ?, updated_at = sdp_datetime_now()
         WHERE provider = 'clerk' AND provider_user_id = ?`
      )
      .bind(email, clerkUserId)
      .run();
  }
}

async function ensureClerkUser(
  env: Env,
  db: DatabaseClient,
  clerkUserId: string,
  fallbackEmail: string
): Promise<{ userId: string; email: string }> {
  const existing = await resolveClerkUser(db, clerkUserId);
  if (existing) {
    // A stored placeholder is worse than no value: it is byte-identical for every
    // affected user, so it identifies nobody, and it is matched literally against
    // `invitations.email` below — which silently denies an invited role. Skip anything
    // that is not an address and fall through to the other copy.
    const email =
      [existing.identity_email, existing.user_email].find(isPlausibleEmail) ?? fallbackEmail;

    // Repair the corrupted copy from the good one while we are holding both.
    // Clerk's own guidance is that webhook delivery is not guaranteed and a synced
    // table should carry an on-demand fallback, and `user.updated` only fires when
    // something changes in Clerk — so an account corrupted once would otherwise stay
    // corrupted through every future sign-in, and every surface reading `users.email`
    // stays wrong with it. Migration 0040 does the same repair, but only on deploy.
    if (isPlausibleEmail(email)) {
      await repairClerkEmails(db, {
        userId: existing.user_id,
        clerkUserId,
        email,
        identityEmail: existing.identity_email,
        userEmail: existing.user_email,
      });
    }

    return { userId: existing.user_id, email };
  }

  const clerkUser = await new ClerkUsersService(env).getUser(clerkUserId);
  const normalizedEmail = verifiedPrimaryEmailFromClerkUser(clerkUser);
  if (!normalizedEmail) {
    throw unauthorized("Clerk primary email must be verified");
  }
  let user = await db
    .prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(normalizedEmail)
    .first<{ id: string; email: string }>();

  if (!user) {
    const userId = `usr_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, ?, 1, 'active')
         ON CONFLICT (email) DO NOTHING`
      )
      .bind(userId, normalizedEmail)
      .run();
    user = await db
      .prepare("SELECT id, email FROM users WHERE email = ?")
      .bind(normalizedEmail)
      .first<{ id: string; email: string }>();
  }

  if (!user) {
    throw internalError("Unable to resolve Clerk user");
  }

  await db
    .prepare(
      `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
       VALUES (?, 'clerk', ?, ?, ?)
       ON CONFLICT (provider, provider_user_id)
       DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, updated_at = sdp_datetime_now()`
    )
    .bind(`aui_${crypto.randomUUID()}`, clerkUserId, user.id, normalizedEmail)
    .run();

  return { userId: user.id, email: user.email };
}

async function ensureMembership(
  c: Context<{ Bindings: Env }>,
  params: {
    organizationId: string;
    userId: string;
    email: string;
  }
): Promise<OrganizationRole> {
  const db = getDb(c.env);
  const existing = await resolveOrgMembership(db, params.userId, params.organizationId);
  if (existing?.status === "suspended") {
    throw unauthorized("Organization membership is inactive");
  }
  if (existing?.status === "active") {
    const normalizedRole = normalizeOrganizationRole(existing.role);
    if (normalizedRole !== existing.role) {
      await db
        .prepare(
          `UPDATE organization_members
           SET role = ?
           WHERE user_id = ? AND organization_id = ? AND status = 'active'`
        )
        .bind(normalizedRole, params.userId, params.organizationId)
        .run();
    }
    return normalizedRole;
  }

  try {
    const pendingInvite = await findPendingInvitation(db, {
      organizationId: params.organizationId,
      email: params.email,
    });

    // Admission comes only from an SDP invitation (ADR 0012): the Clerk
    // membership that let this token name the organization grants nothing.
    if (!pendingInvite) {
      throw unauthorized("No pending invitation to this organization");
    }
    if (new Date(pendingInvite.expiresAt) < new Date()) {
      await db
        .prepare("UPDATE invitations SET status = 'expired' WHERE id = ? AND status = 'pending'")
        .bind(pendingInvite.id)
        .run();
      throw unauthorized("Invitation to this organization has expired");
    }

    const role = pendingInvite.role;
    const memberId = `mem_${crypto.randomUUID()}`;

    // The claim, the membership, its project memberships and the audit record
    // commit together. Claiming first alone would let a failing insert consume
    // the invitation without granting access, and inserting first would let a
    // concurrent revocation win the invitation transition after access was
    // persisted. Admission grants authority, so it never commits unaudited.
    await new AuditService(db).logWithin(c, async (tx) => {
      // The organization was active when this request passed its door, but a
      // deletion can commit after that read. Holding a share lock on the row
      // here makes the deletion either finish first (and this refuses) or
      // wait for this insert (and then remove the membership it finds). It
      // locks the organization before invitations and memberships, the
      // deletion's own order.
      const organization = await tx
        .prepare("SELECT id FROM organizations WHERE id = ? AND status = 'active' FOR SHARE")
        .bind(params.organizationId)
        .first<{ id: string }>();
      if (!organization) {
        throw organizationNotActive();
      }

      // Role normalization folds in here, so there is one transition rather
      // than a read, a role fixup and a later accept.
      const claimed = await tx
        .prepare(
          `UPDATE invitations
              SET status = 'accepted', accepted_at = datetime('now'), role = ?
            WHERE id = ? AND status = 'pending'`
        )
        .bind(role, pendingInvite.id)
        .run();

      // Zero rows means it stopped being pending between the read and here.
      // Revocation is the case that matters, and granting access off a
      // just-revoked invitation is the failure worth refusing.
      if (claimed === 0) {
        throw unauthorized("Invitation is no longer valid");
      }

      // A removed member is reactivated at the invitation's role; any other
      // existing row (a concurrent admission, a suspension) is left alone and
      // rolls the claim back.
      const admitted = await tx
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
             VALUES (?, ?, ?, ?, 'active')
           ON CONFLICT (organization_id, user_id) DO UPDATE
             SET role = EXCLUDED.role, status = 'active'
             WHERE organization_members.status = 'removed'`
        )
        .bind(memberId, params.organizationId, params.userId, role)
        .run();
      if (admitted === 0) {
        throw unauthorized("Organization membership is inactive");
      }

      const projects = await tx
        .prepare("SELECT id FROM projects WHERE organization_id = ? AND status = 'active'")
        .bind(params.organizationId)
        .all<{ id: string }>();
      if (projects.results.length === 0) {
        throw internalError("Organization has no active projects");
      }
      for (const project of projects.results) {
        await tx
          .prepare(
            `INSERT INTO project_members (id, project_id, user_id)
             VALUES ('pm_' || gen_random_uuid(), ?, ?)
             ON CONFLICT (project_id, user_id) DO NOTHING`
          )
          .bind(project.id, params.userId)
          .run();
      }

      return {
        entry: {
          action: "accept_invite",
          resourceType: "invitation",
          resourceId: pendingInvite.id,
          metadata: { email: params.email.toLowerCase(), userId: params.userId, role },
          organizationId: params.organizationId,
          userId: params.userId,
        },
        result: undefined,
      };
    });
    return role;
  } catch (error) {
    // A concurrent sign-in may have admitted this person first: it claimed the
    // invitation before this request read it, or won the claim and rolled ours
    // back. Either way the row that won is the answer.
    const winner = await resolveOrgMembership(db, params.userId, params.organizationId);
    if (winner?.status === "active") {
      return normalizeOrganizationRole(winner.role);
    }
    throw error;
  }
}

async function buildClerkContext(c: Context<{ Bindings: Env }>, payload: ClerkJwtPayload) {
  const email = resolveClerkEmail(payload);
  if (!email) {
    throw unauthorized(
      "Clerk token has no usable email claim. Check the session token customization: an invalid shortcode is passed through unsubstituted rather than resolved."
    );
  }

  const organizationClaims = resolveClerkOrganizationClaims(payload);
  if (!organizationClaims.organizationId) {
    throw unauthorized("Clerk token missing organization");
  }

  // Organizations are created only by SDP (ADR 0012), so a Clerk organization
  // with no mapping has no one SDP admitted. Everything below writes — user
  // provisioning, membership, email repair — so organization access gates
  // entry here: a Clerk organization outlives an SDP deletion, and without
  // this a member could sign back into a deleted organization. The
  // organization's IP allowlist is not checked: it governs API keys only.
  const knownOrganization = await resolveClerkOrganization(
    getDb(c.env),
    organizationClaims.organizationId
  );
  if (!knownOrganization) {
    throw unauthorized("Organization is not provisioned in SDP");
  }
  recordOrganizationEntitlements(
    c,
    await readActiveOrganizationSettings(c.env, knownOrganization.organization_id)
  );

  const existingContext = await resolveExistingClerkContext(getDb(c.env), {
    clerkUserId: payload.sub as string,
    clerkOrgId: organizationClaims.organizationId,
    fallbackOrgSlug: organizationClaims.organizationSlug,
  });

  if (existingContext?.organization_id && existingContext.user_id && existingContext.role) {
    const role = normalizeOrganizationRole(existingContext.role);

    if (role !== existingContext.role) {
      await getDb(c.env)
        .prepare(
          `UPDATE organization_members
           SET role = ?
           WHERE user_id = ? AND organization_id = ? AND status = 'active'`
        )
        .bind(role, existingContext.user_id, existingContext.organization_id)
        .run();
    }

    const resolvedEmail =
      [existingContext.identity_email, existingContext.user_email].find(isPlausibleEmail) ??
      email.toLowerCase();

    // This is the branch an established member actually takes, and it returns before
    // `ensureClerkUser` — so repairing only in there left the corrupted population the
    // one population never repaired. It matters beyond the directory: the duplicate
    // guard in `inviteMember` matches `users.email` literally, so a row still holding a
    // placeholder lets an existing member be re-invited. A healthy row issues no writes.
    await repairClerkEmails(getDb(c.env), {
      userId: existingContext.user_id,
      clerkUserId: payload.sub as string,
      email: resolvedEmail,
      identityEmail: existingContext.identity_email,
      userEmail: existingContext.user_email,
    });

    return {
      userId: existingContext.user_id,
      organizationId: existingContext.organization_id,
      role,
      clerkUserId: payload.sub as string,
      clerkOrgId: organizationClaims.organizationId,
      email: resolvedEmail,
      orgSlug: organizationClaims.organizationSlug ?? existingContext.org_slug,
    };
  }

  const userIdentity = await ensureClerkUser(c.env, getDb(c.env), payload.sub as string, email);

  const role = await ensureMembership(c, {
    organizationId: knownOrganization.organization_id,
    userId: userIdentity.userId,
    email: userIdentity.email,
  });

  return {
    userId: userIdentity.userId,
    organizationId: knownOrganization.organization_id,
    role,
    clerkUserId: payload.sub as string,
    clerkOrgId: organizationClaims.organizationId,
    email: userIdentity.email,
    orgSlug: organizationClaims.organizationSlug ?? knownOrganization.slug,
  };
}

function assertClerkTenantClaims(payload: ClerkJwtPayload): void {
  if (!payload.sub) {
    throw unauthorized("Clerk token missing subject");
  }
  if (!resolveClerkOrganizationClaims(payload).organizationId) {
    throw unauthorized("Clerk token missing organization");
  }
}

/**
 * The rest of a signed-in request: narrowed to the member's organization, and
 * moving money as the member (HOO-2099). The signing waists re-read the
 * membership whenever it signs for them.
 */
function runAsSignedInMember(
  clerk: { userId: string; organizationId: string },
  next: Next
): Promise<void> {
  return runWithTenantDatabaseIdentity({ organizationId: clerk.organizationId }, () =>
    runAsMoneyPrincipal({ kind: "member", userId: clerk.userId }, next)
  );
}

export function clerkAuthMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Identity mapping, membership sync, and default-project provisioning all
    // read and write across organizations before the tenant is established,
    // so they run under the system database identity; the rest of the request
    // narrows to the token's organization.
    const clerkContext = await runWithSystemDatabaseIdentity("http:auth", async () => {
      const token = extractBearerToken(c);

      if (!token) {
        throw unauthorized("Clerk session required");
      }

      const payload = await verifyClerkSessionToken(c, token);

      assertClerkTenantClaims(payload);

      const context = await buildClerkContext(c, payload);

      // Dashboard traffic bypasses the pre-auth per-IP limiter (verified Clerk
      // JWTs are exempted there), so this per-user-per-org limit is the only
      // general ceiling on Clerk-authenticated requests.
      await enforceRateLimit(
        c,
        `user:${context.userId}:org:${context.organizationId}`,
        DASHBOARD_ACTOR_MAX_REQUESTS
      );

      c.set("clerk", context);
      return context;
    });

    await runAsSignedInMember(clerkContext, next);
  };
}

/**
 * Authenticates a verified Clerk session that names no organization SDP links,
 * for the one route that creates a person's organization (ADR 0012): a new
 * person has no organization yet, so the member middleware refuses them. The rest of the
 * request runs under a system database identity, since it writes the
 * organization before any tenant exists.
 *
 * @returns The middleware.
 */
export function clerkSignupSessionMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    await runWithSystemDatabaseIdentity("http:organization-signup", async () => {
      const token = extractBearerToken(c);
      if (!token) {
        throw unauthorized("Clerk session required");
      }
      const payload = await verifyClerkSessionToken(c, token);
      if (!payload.sub) {
        throw unauthorized("Clerk token missing subject");
      }
      const email = resolveClerkEmail(payload);
      if (!email) {
        throw unauthorized("Clerk token has no usable email claim");
      }
      // Limited before anything is written: provisioning the user is itself a write.
      await enforceRateLimit(
        c,
        `clerk:${payload.sub}:organization-signup`,
        DASHBOARD_ACTOR_MAX_REQUESTS
      );
      const db = getDb(c.env);
      // Clerk keeps an organization active whenever the person has one
      // (personal accounts are off), so an active organization SDP never
      // linked is no claim on anything and is allowed. One SDP links stays
      // refused: that person belongs in it, not in a new one. Creation never
      // reads the claim either way; it makes a new Clerk organization.
      const activeClerkOrgId = resolveClerkOrganizationClaims(payload).organizationId;
      if (activeClerkOrgId && (await resolveClerkOrganization(db, activeClerkOrgId))) {
        throw badRequest("Clear the active organization before creating one");
      }
      const user = await ensureClerkUser(c.env, db, payload.sub, email);
      c.set("clerkSignup", { userId: user.userId, clerkUserId: payload.sub, email: user.email });
      await next();
    });
  };
}

/**
 * The signed-in person with no organization that `clerkSignupSessionMiddleware`
 * authenticated.
 *
 * @param c - The request context.
 * @returns The person.
 */
export function requireClerkSignup(
  c: Context<{ Bindings: Env }>
): NonNullable<ContextVariableMap["clerkSignup"]> {
  const signup = c.get("clerkSignup");
  if (!signup) {
    throw internalError("Route has no signup session step");
  }
  return signup;
}

export function optionalClerkAuth(options: { rejectInvalid?: boolean } = {}) {
  const rejectInvalid = options.rejectInvalid ?? true;
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const token = extractBearerToken(c);

    if (!token) {
      await next();
      return;
    }

    try {
      await runWithSystemDatabaseIdentity("http:auth", async () => {
        const payload = await verifyClerkSessionToken(c, token);
        assertClerkTenantClaims(payload);
        const clerkContext = await buildClerkContext(c, payload);
        await enforceRateLimit(
          c,
          `user:${clerkContext.userId}:org:${clerkContext.organizationId}`,
          DASHBOARD_ACTOR_MAX_REQUESTS
        );
        c.set("clerk", clerkContext);
      });
    } catch (error) {
      // Invalid Clerk auth is rejected by default (a presented credential
      // must never silently downgrade to anonymous). Rate limiting and
      // unreachable signing keys are always rejected: a limited user, or one
      // whose token was never checked, must not proceed as anonymous either.
      if (
        rejectInvalid ||
        (error instanceof AppError &&
          (error.code === "RATE_LIMITED" || error.code === "SERVICE_UNAVAILABLE"))
      ) {
        throw error;
      }
    }

    const clerk = c.get("clerk");
    if (clerk) {
      await runAsSignedInMember(clerk, next);
      return;
    }
    await next();
  };
}
