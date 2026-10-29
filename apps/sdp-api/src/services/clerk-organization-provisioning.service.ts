import type { DatabaseExecutor } from "@/db/client";
import type { ClerkOrganization } from "./clerk-organizations.service";
import { syncProviderAccessFromClerk } from "./provider-availability.service";

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

/**
 * A slug no other organization holds, derived from `base`.
 *
 * @param db - The database.
 * @param base - The name or slug to derive it from.
 * @param organizationId - The organization the slug is for, which may already hold it.
 * @returns The slug.
 */
export async function ensureUniqueSlug(
  db: DatabaseClient,
  base: string,
  organizationId: string
): Promise<string> {
  const normalized = slugify(base) || `org-${crypto.randomUUID().slice(0, 8)}`;
  const isTaken = async (slug: string) =>
    (await db
      .prepare("SELECT id FROM organizations WHERE slug = ? AND id <> ?")
      .bind(slug, organizationId)
      .first()) !== null;

  if (!(await isTaken(normalized))) return normalized;

  let candidate = `${normalized}-${crypto.randomUUID().slice(0, 6)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await isTaken(candidate))) return candidate;
    candidate = `${normalized}-${crypto.randomUUID().slice(0, 6)}`;
  }

  return candidate;
}

/**
 * The Clerk organization an SDP organization maps to.
 *
 * @param db - The database or open transaction.
 * @param organizationId - The SDP organization.
 * @returns The Clerk organization id, or null when it has none yet.
 */
export async function findClerkOrganizationId(
  db: DatabaseExecutor,
  organizationId: string
): Promise<string | null> {
  const mapping = await db
    .prepare(
      `SELECT provider_org_id FROM auth_organization_identities
        WHERE provider = 'clerk' AND organization_id = ?`
    )
    .bind(organizationId)
    .first<{ provider_org_id: string }>();
  return mapping ? mapping.provider_org_id : null;
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

/**
 * Copies a Clerk organization's entitlement metadata (private metadata, which
 * operators set in Clerk) onto the SDP organization it maps to. SDP owns the
 * name and slug (ADR 0012) and creates every organization, so a Clerk
 * organization SDP does not know is left alone.
 *
 * @param params.db - The database.
 * @param params.organization - The Clerk organization, as Clerk holds it now.
 * @returns The mapping it synced, or null when SDP does not know the organization.
 */
export async function syncClerkOrganization(params: {
  db: DatabaseClient;
  organization: ClerkOrganization;
}): Promise<ClerkOrganizationMapping | null> {
  const mapping = await findClerkOrganizationMapping(params.db, params.organization.id);
  if (!mapping) {
    return null;
  }

  await syncProviderAccessFromClerk(params.db, {
    organizationId: mapping.organizationId,
    clerkOrganization: params.organization,
  });

  return mapping;
}
