import type { OrganizationProviderOverrides } from "@sdp/types/provider-access";
import type { DatabaseClient } from "@/db/client";

/**
 * Merge `providerOverrides` into an organization's settings, keeping its other
 * settings (such as the production entitlement `seedDefaultProjects` grants).
 * @param db - Test database client.
 * @param organizationId - The organization to update.
 * @param overrides - The provider overrides to store.
 * @returns Resolves once the row is updated.
 */
export async function setOrganizationProviderOverrides(
  db: DatabaseClient,
  organizationId: string,
  overrides: OrganizationProviderOverrides
): Promise<void> {
  const updated = await db.execute(
    `UPDATE organizations
     SET settings = (COALESCE(NULLIF(settings, ''), '{}')::jsonb
                     || jsonb_build_object('providerOverrides', ?::jsonb))::text
     WHERE id = ?`,
    [JSON.stringify(overrides), organizationId]
  );
  if (updated !== 1) {
    throw new Error(`Organization ${organizationId} not found`);
  }
}
