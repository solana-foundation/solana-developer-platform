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

async function ensureUniqueSlug(
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
 * Copies a Clerk organization's name, slug and entitlement metadata onto the
 * SDP organization it maps to. SDP creates every organization (ADR 0012), so
 * a Clerk organization SDP does not know is left alone.
 *
 * @param params.db - The database.
 * @param params.organization - The Clerk organization from the webhook.
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

  await syncProviderAccessFromClerk(params.db, {
    organizationId: mapping.organizationId,
    clerkOrganization: params.organization,
  });

  return { organizationId: mapping.organizationId, slug };
}
