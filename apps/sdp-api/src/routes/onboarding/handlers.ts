import { normalizeOrganizationTier } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { parseOptionalPostgresJson } from "@/db/postgres-utils";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

async function fetchOrganization(db: DatabaseClient, orgId: string) {
  const org = await db
    .prepare(
      `SELECT id, name, slug, tier, status, settings, created_at, updated_at
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
  };
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
    return success(c, { linked: false, organization: null });
  }

  const organization = await fetchOrganization(getDb(c.env), mapping.organization_id);
  return success(c, { linked: true, organization });
};
