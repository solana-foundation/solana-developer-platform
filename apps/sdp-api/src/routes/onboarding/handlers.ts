import { CUSTODY_PROVIDERS, type CustodyProvider, normalizeOrganizationTier } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { parseOptionalPostgresJson } from "@/db/postgres-utils";
import { AppError, badRequest, forbidden, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import type { Env } from "@/types/env";
import type { completeOnboardingSchema } from "./schemas";
import { ONBOARDING_VERSION, resolveOnboardingSetup } from "./state";

type AppContext = Context<{ Bindings: Env }>;

async function fetchOrganization(db: DatabaseClient, orgId: string) {
  const org = await db
    .prepare(
      `SELECT id, name, slug, tier, status, settings, onboarding_completed_at,
              onboarding_version, created_at, updated_at
       FROM organizations WHERE id = ?`
    )
    .bind(orgId)
    .first<{
      id: string;
      name: string;
      slug: string;
      tier: string;
      status: string;
      settings: string | null;
      onboarding_completed_at: string | null;
      onboarding_version: number;
      created_at: string;
      updated_at: string;
    }>();

  if (!org) {
    throw notFound("Organization");
  }

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    tier: normalizeOrganizationTier(org.tier),
    status: org.status as "active" | "suspended" | "deleted",
    settings: parseOptionalPostgresJson(org.settings),
    createdAt: org.created_at,
    updatedAt: org.updated_at,
    onboardingCompletedAt: org.onboarding_completed_at,
    onboardingVersion: org.onboarding_version,
  };
}

/**
 * The distinct custody providers backing the organization's default sandbox
 * project: every provider with an active Managed config or an active BYOK
 * connection there, in `CUSTODY_PROVIDERS` order.
 *
 * @param db - Database client.
 * @param organizationId - The organization whose default sandbox project is read.
 * @returns The providers in tuple order, empty when the project has no custody backend.
 */
async function fetchCustodyProviders(
  db: DatabaseClient,
  organizationId: string
): Promise<CustodyProvider[]> {
  const { results } = await db
    .prepare(
      `SELECT cc.provider
         FROM projects p
         JOIN custody_configs cc
           ON cc.organization_id = p.organization_id AND cc.project_id = p.id
        WHERE p.organization_id = ?
          AND p.slug = 'default-sandbox'
          AND p.environment = 'sandbox'
          AND p.status = 'active'
          AND cc.status = 'active'
       UNION
       SELECT conn.provider
         FROM projects p
         JOIN custody_connections conn
           ON conn.organization_id = p.organization_id AND conn.project_id = p.id
        WHERE p.organization_id = ?
          AND p.slug = 'default-sandbox'
          AND p.environment = 'sandbox'
          AND p.status = 'active'
          AND conn.status = 'active'`
    )
    .bind(organizationId, organizationId)
    .all<{ provider: string }>();

  const backed = new Set(results.map((row) => row.provider));
  return CUSTODY_PROVIDERS.filter((provider) => backed.has(provider));
}

function canManageOnboarding(orgRole: string | null): boolean {
  return orgRole === "org:admin" || orgRole === "admin";
}

async function buildOnboardingSetup(params: {
  clerkOrgRole: string | null;
  db: DatabaseClient;
  organization: Awaited<ReturnType<typeof fetchOrganization>>;
}) {
  const custodyProviders = await fetchCustodyProviders(params.db, params.organization.id);
  return resolveOnboardingSetup({
    completedAt: params.organization.onboardingCompletedAt,
    custodyProviders,
    version: params.organization.onboardingVersion ?? ONBOARDING_VERSION,
    canManage: canManageOnboarding(params.clerkOrgRole),
  });
}

export const getOnboardingStatus = async (c: AppContext) => {
  const clerk = c.get("clerkOnboarding");
  if (!clerk) {
    throw new AppError("UNAUTHORIZED", "Clerk session required");
  }

  const mapping = await getDb(c.env)
    .prepare(
      `SELECT organization_id
     FROM auth_organization_identities
     WHERE provider = 'clerk' AND provider_org_id = ?`
    )
    .bind(clerk.clerkOrgId)
    .first<{ organization_id: string }>();

  if (!mapping) {
    return success(c, { linked: false, organization: null, setup: null });
  }

  const db = getDb(c.env);
  const organization = await fetchOrganization(db, mapping.organization_id);
  const setup = await buildOnboardingSetup({
    clerkOrgRole: clerk.orgRole,
    db,
    organization,
  });
  const { onboardingCompletedAt: _, onboardingVersion: __, ...organizationResponse } = organization;
  return success(c, { linked: true, organization: organizationResponse, setup });
};

export const completeOnboarding = async (
  c: ValidatedBodyContext<typeof completeOnboardingSchema>
) => {
  const clerk = c.get("clerkOnboarding");
  if (!clerk) {
    throw new AppError("UNAUTHORIZED", "Clerk session required");
  }
  if (!canManageOnboarding(clerk.orgRole)) {
    throw forbidden("Only organization admins can finish setup");
  }

  const db = getDb(c.env);
  const mapping = await db
    .prepare(
      `SELECT organization_id
       FROM auth_organization_identities
       WHERE provider = 'clerk' AND provider_org_id = ?`
    )
    .bind(clerk.clerkOrgId)
    .first<{ organization_id: string }>();
  if (!mapping) {
    throw notFound("Organization");
  }

  const organization = await fetchOrganization(db, mapping.organization_id);
  const requestedProvider = c.req.valid("json").custodyProvider;
  const custodyProviders = await fetchCustodyProviders(db, organization.id);
  if (!custodyProviders.includes(requestedProvider)) {
    throw badRequest(
      "Set up the requested custody provider for the sandbox project before finishing setup"
    );
  }

  await db
    .prepare(
      `UPDATE organizations
       SET onboarding_completed_at = COALESCE(onboarding_completed_at, sdp_datetime_now()),
           onboarding_version = ?,
           updated_at = sdp_datetime_now()
       WHERE id = ?`
    )
    .bind(ONBOARDING_VERSION, organization.id)
    .run();

  const completed = await fetchOrganization(db, organization.id);
  const setup = await buildOnboardingSetup({
    clerkOrgRole: clerk.orgRole,
    db,
    organization: completed,
  });
  return success(c, { setup });
};
