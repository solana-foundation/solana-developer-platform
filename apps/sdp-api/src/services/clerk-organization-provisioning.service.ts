import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import type { Env } from "@/types/env";
import type { ClerkOrganization } from "./clerk-organizations.service";
import {
  parseClerkOrganizationTierMetadata,
  syncProviderAccessFromClerk,
} from "./provider-availability.service";

export interface ClerkOrganizationMapping {
  organizationId: string;
  slug: string | null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureUniqueSlug(
  db: DatabaseClient,
  base: string,
  excludeOrganizationId?: string
): Promise<string> {
  const normalized = slugify(base) || `org-${crypto.randomUUID().slice(0, 8)}`;
  const existing = await db
    .prepare(
      excludeOrganizationId
        ? "SELECT id FROM organizations WHERE slug = ? AND id <> ?"
        : "SELECT id FROM organizations WHERE slug = ?"
    )
    .bind(...(excludeOrganizationId ? [normalized, excludeOrganizationId] : [normalized]))
    .first();

  if (!existing) return normalized;

  let candidate = `${normalized}-${crypto.randomUUID().slice(0, 6)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const taken = await db
      .prepare(
        excludeOrganizationId
          ? "SELECT id FROM organizations WHERE slug = ? AND id <> ?"
          : "SELECT id FROM organizations WHERE slug = ?"
      )
      .bind(...(excludeOrganizationId ? [candidate, excludeOrganizationId] : [candidate]))
      .first();
    if (!taken) return candidate;
    candidate = `${normalized}-${crypto.randomUUID().slice(0, 6)}`;
  }

  return candidate;
}

export async function findClerkOrganizationMapping(
  db: DatabaseClient,
  clerkOrganizationId: string
): Promise<ClerkOrganizationMapping | null> {
  const mapping = await db
    .prepare(
      `SELECT organization_id, slug
       FROM auth_organization_identities
       WHERE provider = 'clerk' AND provider_org_id = ?`
    )
    .bind(clerkOrganizationId)
    .first<{ organization_id: string; slug: string | null }>();

  return mapping ? { organizationId: mapping.organization_id, slug: mapping.slug } : null;
}

export async function ensureClerkOrganizationMapping(params: {
  env: Env;
  db: DatabaseClient;
  organization: ClerkOrganization;
}): Promise<ClerkOrganizationMapping> {
  const existing = await findClerkOrganizationMapping(params.db, params.organization.id);
  if (existing) return existing;

  const name =
    params.organization.name?.trim() || params.organization.slug?.trim() || "Organization";
  const slug = await ensureUniqueSlug(params.db, params.organization.slug || name);
  const organizationId = `org_${crypto.randomUUID()}`;
  const providerState = isSelfHostedDeployment(params.env)
    ? { tier: "enterprise" as const, providerOverrides: undefined }
    : parseClerkOrganizationTierMetadata(params.organization);
  const settings = providerState.providerOverrides
    ? JSON.stringify({ providerOverrides: providerState.providerOverrides })
    : null;

  // Persist Clerk-derived access state with the mapping so provisioning cannot
  // commit an organization that depends on a later repair update succeeding.
  try {
    await params.db.batch([
      params.db
        .prepare(
          `INSERT INTO organizations (id, name, slug, tier, settings, status)
           VALUES (?, ?, ?, ?, ?, 'active')`
        )
        .bind(organizationId, name, slug, providerState.tier, settings),
      params.db
        .prepare(
          `INSERT INTO auth_organization_identities
             (id, provider, provider_org_id, organization_id, slug)
           VALUES (?, 'clerk', ?, ?, ?)`
        )
        .bind(`aoi_${crypto.randomUUID()}`, params.organization.id, organizationId, slug),
    ]);
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      const concurrent = await findClerkOrganizationMapping(params.db, params.organization.id);
      if (concurrent) return concurrent;
    }
    throw error;
  }

  return { organizationId, slug };
}

export async function syncClerkOrganization(params: {
  env: Env;
  db: DatabaseClient;
  organization: ClerkOrganization;
}): Promise<ClerkOrganizationMapping> {
  const mapping = await ensureClerkOrganizationMapping(params);
  const name =
    params.organization.name?.trim() || params.organization.slug?.trim() || "Organization";
  const slug = await ensureUniqueSlug(
    params.db,
    params.organization.slug || name,
    mapping.organizationId
  );

  await params.db.batch([
    params.db
      .prepare(
        `UPDATE auth_organization_identities
         SET slug = ?, updated_at = sdp_datetime_now()
         WHERE provider = 'clerk' AND provider_org_id = ?`
      )
      .bind(slug, params.organization.id),
    params.db
      .prepare(
        `UPDATE organizations
         SET name = ?, slug = ?, updated_at = sdp_datetime_now()
         WHERE id = ?`
      )
      .bind(name, slug, mapping.organizationId),
  ]);

  if (!isSelfHostedDeployment(params.env)) {
    await syncProviderAccessFromClerk(params.db, {
      organizationId: mapping.organizationId,
      clerkOrganization: params.organization,
    });
  }

  return { organizationId: mapping.organizationId, slug };
}
