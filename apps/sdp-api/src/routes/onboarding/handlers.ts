import {
  CUSTODY_PROVIDERS,
  type CustodyProvider,
  normalizeOrganizationTier,
  ORGANIZATION_RPC_PROVIDERS,
  type OrganizationRpcProvider,
} from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { parseOptionalPostgresJson } from "@/db/postgres-utils";
import { AppError, badRequest, forbidden, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { Env } from "@/types/env";
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

function resolveRpcProvider(settings: unknown): OrganizationRpcProvider | null {
  if (!settings || typeof settings !== "object" || !("rpcProvider" in settings)) {
    return null;
  }

  const provider = (settings as { rpcProvider?: unknown }).rpcProvider;
  return ORGANIZATION_RPC_PROVIDERS.includes(provider as OrganizationRpcProvider)
    ? (provider as OrganizationRpcProvider)
    : null;
}

async function fetchCustodyProvider(
  db: DatabaseClient,
  organizationId: string
): Promise<CustodyProvider | null> {
  const row = await db
    .prepare(
      `SELECT cc.provider
       FROM custody_configs cc
       INNER JOIN custody_wallets cw ON cw.custody_config_id = cc.id
       WHERE cc.organization_id = ?
         AND cc.status = 'active'
         AND cw.status = 'active'
       ORDER BY cw.created_at ASC
       LIMIT 1`
    )
    .bind(organizationId)
    .first<{ provider: string }>();

  return row && CUSTODY_PROVIDERS.includes(row.provider as CustodyProvider)
    ? (row.provider as CustodyProvider)
    : null;
}

function canManageOnboarding(orgRole: string | null): boolean {
  return orgRole === "org:admin" || orgRole === "admin";
}

async function buildOnboardingSetup(params: {
  clerkOrgRole: string | null;
  db: DatabaseClient;
  organization: Awaited<ReturnType<typeof fetchOrganization>>;
}) {
  const custodyProvider = await fetchCustodyProvider(params.db, params.organization.id);
  return resolveOnboardingSetup({
    completedAt: params.organization.onboardingCompletedAt,
    rpcProvider: resolveRpcProvider(params.organization.settings),
    custodyProvider,
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

export const completeOnboarding = async (c: AppContext) => {
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
  const rpcProvider = resolveRpcProvider(organization.settings);
  const custodyProvider = await fetchCustodyProvider(db, organization.id);
  if (!rpcProvider) {
    throw badRequest("Select an RPC provider before finishing setup");
  }
  if (!custodyProvider) {
    throw badRequest("Create a custody wallet before finishing setup");
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
