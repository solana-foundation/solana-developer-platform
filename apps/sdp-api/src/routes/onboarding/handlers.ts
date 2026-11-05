import { CUSTODY_PROVIDERS, type CustodyProvider } from "@sdp/types/custody";
import type { OrganizationOnboardingSetup, OrganizationSettings } from "@sdp/types/organizations";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { parseOptionalPostgresJson } from "@/db/postgres-utils";
import { notFound } from "@/lib/errors";
import { projectOrganizationSettings } from "@/lib/organization-access";
import { success } from "@/lib/response";
import { getAuthorized } from "@/middleware/authorize";
import type { Env } from "@/types/env";
import type { OnboardingAccess } from "./access";

type AppContext = Context<{ Bindings: Env }>;

async function fetchOrganization(db: DatabaseClient, orgId: string) {
  const org = await db
    .prepare(
      `SELECT id, name, slug, status, settings, created_at, updated_at
       FROM organizations WHERE id = ?`
    )
    .bind(orgId)
    .first<{
      id: string;
      name: string;
      slug: string;
      status: string;
      settings: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (!org) {
    throw notFound("Organization");
  }
  const storedSettings = parseOptionalPostgresJson<OrganizationSettings>(org.settings);

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status as "active" | "suspended" | "deleted",
    settings: storedSettings === null ? null : projectOrganizationSettings(storedSettings),
    createdAt: org.created_at,
    updatedAt: org.updated_at,
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

async function buildOnboardingSetup(params: {
  canManage: boolean;
  db: DatabaseClient;
  organization: Awaited<ReturnType<typeof fetchOrganization>>;
}): Promise<OrganizationOnboardingSetup> {
  const custodyProviders = await fetchCustodyProviders(params.db, params.organization.id);
  return { custodyProviders, canManage: params.canManage };
}

export const getOnboardingStatus = async (c: AppContext) => {
  const { session, memberRole } = getAuthorized<OnboardingAccess>(c);

  if (!session.organizationId) {
    return success(c, { linked: false, organization: null, setup: null });
  }

  const db = getDb(c.env);
  const organization = await fetchOrganization(db, session.organizationId);
  const setup = await buildOnboardingSetup({
    canManage: memberRole === "admin",
    db,
    organization,
  });
  return success(c, { linked: true, organization, setup });
};
