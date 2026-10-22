import { ORGANIZATION_STATUSES } from "@sdp/types/organizations";
import type { Context } from "hono";
import { z } from "zod";
import { type DatabaseClient, getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { conflict, internalError } from "@/lib/errors";
import { created } from "@/lib/response";
import { requireClerkSignup } from "@/middleware/clerk-auth";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import {
  ensureUniqueSlug,
  findClerkOrganizationId,
} from "@/services/clerk-organization-provisioning.service";
import { ClerkOrganizationsService } from "@/services/clerk-organizations.service";
import type { Env } from "@/types/env";
import { type OrganizationRow, toOrganizationResponse } from "./handlers";
import type { createOrganizationSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

const ORGANIZATION_COLUMNS = "id, name, slug, tier, status, settings, created_at, updated_at";
const SLUG_ATTEMPTS = 3;
const organizationStatusSchema = z.object({ status: z.enum(ORGANIZATION_STATUSES) });

/**
 * Creates the caller's organization (ADR 0012), staged so that a retry after
 * any failure finishes it instead of starting another: the `provisioning` row
 * claims the caller's one-organization slot, then the Clerk organization and
 * the caller's `org:member` Clerk membership are created, then the admin
 * membership, both default projects and `active` commit with their audit
 * record. Every step resumes from what the previous attempt stored; the
 * creator's unique slot is the request's idempotency key, so a retry naming
 * another name is refused.
 */
export const createOrganization = async (
  c: ValidatedBodyContext<typeof createOrganizationSchema>
) => {
  const signup = requireClerkSignup(c);
  const { name } = c.req.valid("json");
  const db = getDb(c.env);

  const organization = await claimOrganization(db, { name, creatorUserId: signup.userId });
  // An active organization is a retry of a request that finished, answered
  // only while its creator still belongs to it: nothing is written again, in
  // Clerk above all, where it could re-add a creator another admin removed.
  // A removed creator keeps the slot; a person creates one organization.
  if (organization.status === "active") {
    await assertCreatorStillMember(db, { organizationId: organization.id, userId: signup.userId });
  }
  const clerkOrganizationId =
    organization.status === "active"
      ? await readClerkOrganizationId(db, organization.id)
      : await provisionClerkOrganization(c, { organization, clerkUserId: signup.clerkUserId });
  if (organization.status === "provisioning") {
    await activateOrganization(c, {
      organizationId: organization.id,
      creatorUserId: signup.userId,
    });
  }

  const active = await db
    .prepare(`SELECT ${ORGANIZATION_COLUMNS} FROM organizations WHERE id = ?`)
    .bind(organization.id)
    .first<OrganizationRow>();
  if (!active) {
    throw internalError("Created organization is missing");
  }
  return created(c, { organization: toOrganizationResponse(active), clerkOrganizationId });
};

/**
 * Inserts the organization as `provisioning`, or returns the one the caller
 * already created. The insert is the claim: the creator's unique index decides
 * concurrent attempts before anything reaches Clerk.
 *
 * @param db - The database.
 * @param params.name - The requested name.
 * @param params.creatorUserId - The caller.
 * @returns The caller's organization.
 */
async function claimOrganization(
  db: DatabaseClient,
  params: { name: string; creatorUserId: string }
): Promise<OrganizationRow> {
  // The creator's slot is decided by ON CONFLICT; a unique violation is then
  // only the slug, which another organization took between the check and the
  // insert, so a fresh one is tried.
  const id = `org_${crypto.randomUUID()}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db
        .prepare(
          `INSERT INTO organizations (id, name, slug, status, created_by_user_id)
           VALUES (?, ?, ?, 'provisioning', ?)
           ON CONFLICT (created_by_user_id) WHERE created_by_user_id IS NOT NULL AND status <> 'deleted'
           DO NOTHING`
        )
        .bind(id, params.name, await ensureUniqueSlug(db, params.name, id), params.creatorUserId)
        .run();
      break;
    } catch (error) {
      if (!isPostgresUniqueViolation(error) || attempt === SLUG_ATTEMPTS) {
        throw error;
      }
    }
  }

  const existing = await db
    .prepare(
      `SELECT ${ORGANIZATION_COLUMNS} FROM organizations
        WHERE created_by_user_id = ? AND status <> 'deleted'`
    )
    .bind(params.creatorUserId)
    .first<OrganizationRow>();
  if (!existing) {
    throw internalError("Organization claim is missing");
  }
  // The name is part of the claim: a retry finishes the organization it
  // started, and another name is a second organization, which a person may
  // not create.
  if (existing.name !== params.name) {
    throw conflict("You have already created an organization");
  }
  if (existing.status === "suspended") {
    throw conflict("Your organization is suspended");
  }
  return existing;
}

/**
 * The Clerk organization an active organization maps to.
 *
 * @param db - The database.
 * @param organizationId - The SDP organization.
 * @returns The Clerk organization id.
 */
async function readClerkOrganizationId(
  db: DatabaseClient,
  organizationId: string
): Promise<string> {
  const clerkOrganizationId = await findClerkOrganizationId(db, organizationId);
  if (clerkOrganizationId === null) {
    throw internalError("Active organization has no Clerk organization");
  }
  return clerkOrganizationId;
}

/**
 * Refuses a creator who no longer belongs to the organization they created.
 *
 * @param db - The database.
 * @param params.organizationId - The organization.
 * @param params.userId - The creator.
 */
async function assertCreatorStillMember(
  db: DatabaseClient,
  params: { organizationId: string; userId: string }
): Promise<void> {
  const member = await db
    .prepare(
      `SELECT id FROM organization_members
        WHERE organization_id = ? AND user_id = ? AND status = 'active'`
    )
    .bind(params.organizationId, params.userId)
    .first<{ id: string }>();
  if (!member) {
    throw conflict("You have already created an organization");
  }
}

/**
 * Creates the Clerk organization and the caller's `org:member` membership of
 * it, unless an earlier attempt did. The organization row stays locked across
 * each Clerk step, so concurrent attempts create one Clerk organization and
 * one membership; a
 * crash between Clerk's answer and the mapping insert leaves an empty Clerk
 * organization SDP never maps, which no one can sign in to.
 *
 * @param c - The request context.
 * @param params.organization - The caller's organization.
 * @param params.clerkUserId - The caller's Clerk user id.
 * @returns The Clerk organization id.
 */
async function provisionClerkOrganization(
  c: AppContext,
  params: { organization: OrganizationRow; clerkUserId: string }
): Promise<string> {
  const clerk = new ClerkOrganizationsService(c.env);
  const clerkOrganizationId = await getDb(c.env).transaction(async (tx) => {
    await tx
      .prepare("SELECT id FROM organizations WHERE id = ? FOR UPDATE")
      .bind(params.organization.id)
      .first();
    const mapped = await findClerkOrganizationId(tx, params.organization.id);
    if (mapped !== null) {
      return mapped;
    }
    const createdId = await clerk.createOrganization({
      name: params.organization.name,
      sdpOrganizationId: params.organization.id,
    });
    await tx
      .prepare(
        `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(
        `aoi_${crypto.randomUUID()}`,
        createdId,
        params.organization.id,
        params.organization.slug
      )
      .run();
    return createdId;
  });

  // A separate transaction under the same lock: a failed membership call must
  // not roll back the mapping of a Clerk organization that now exists, and
  // concurrent attempts must not both add the membership.
  const membership = { organizationId: clerkOrganizationId, userId: params.clerkUserId };
  await getDb(c.env).transaction(async (tx) => {
    await tx
      .prepare("SELECT id FROM organizations WHERE id = ? FOR UPDATE")
      .bind(params.organization.id)
      .first();
    if (!(await clerk.hasOrganizationMembership(membership))) {
      await clerk.createOrganizationMembership(membership);
    }
  });
  return clerkOrganizationId;
}

/**
 * Makes the caller the organization's admin with both default projects and
 * activates it, recorded in the same transaction. An organization already
 * active is a retry of a request that finished, and records nothing.
 *
 * @param c - The request context.
 * @param params.organizationId - The organization.
 * @param params.creatorUserId - The caller.
 */
async function activateOrganization(
  c: AppContext,
  params: { organizationId: string; creatorUserId: string }
): Promise<void> {
  await new AuditService(getDb(c.env)).logWithin(c, async (tx) => {
    const current = await tx
      .prepare("SELECT status FROM organizations WHERE id = ? FOR UPDATE")
      .bind(params.organizationId)
      .first<Record<string, unknown>>();
    if (!current) {
      throw internalError("Provisioning organization is missing");
    }
    const { status } = organizationStatusSchema.parse(current);
    // A concurrent attempt activated it first.
    if (status !== "provisioning") {
      return { entry: null, result: undefined };
    }
    await tx
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')
         ON CONFLICT (organization_id, user_id) DO NOTHING`
      )
      .bind(`mem_${crypto.randomUUID()}`, params.organizationId, params.creatorUserId)
      .run();
    await tx
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, description, environment, status, created_by)
         VALUES
           ('prj_' || gen_random_uuid(), ?, 'Default Sandbox Project', 'default-sandbox',
            'Default sandbox project', 'sandbox', 'active', ?),
           ('prj_' || gen_random_uuid(), ?, 'Default Production Project', 'default-production',
            'Default production project', 'production', 'active', ?)
         ON CONFLICT (organization_id, slug) DO NOTHING`
      )
      .bind(
        params.organizationId,
        params.creatorUserId,
        params.organizationId,
        params.creatorUserId
      )
      .run();
    await tx
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id)
         SELECT 'pm_' || gen_random_uuid(), id, ?
           FROM projects
          WHERE organization_id = ? AND status = 'active'
         ON CONFLICT (project_id, user_id) DO NOTHING`
      )
      .bind(params.creatorUserId, params.organizationId)
      .run();
    await tx
      .prepare(
        `UPDATE organizations SET status = 'active', updated_at = sdp_datetime_now()
          WHERE id = ? AND status = 'provisioning'`
      )
      .bind(params.organizationId)
      .run();
    return {
      entry: {
        action: "create",
        resourceType: "organization",
        resourceId: params.organizationId,
        organizationId: params.organizationId,
        userId: params.creatorUserId,
      },
      result: undefined,
    };
  });
}
