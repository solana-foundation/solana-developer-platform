import { getAssetTypeRegistryEntry } from "@sdp/types";
import type { AppDb } from "@/db";
import { createPostgresAssetProfilesRepository } from "@/db/repositories";
import { projectPublicMetadata } from "@/lib/issuance/public-metadata";

/**
 * Rebind the active asset profile's cached public projection to a token's
 * authoritative mint/accounting scale (SOLA9-439).
 *
 * A token's decimals stay editable until deploy, and the cached `public_metadata`
 * publishes `chain.decimals` verbatim — so whenever the token row's scale
 * changes, the cache must be recomputed from it, not left carrying the last
 * caller claim. The token PATCH path calls this inside the same transaction
 * that writes the new decimals; the profile PATCH path takes the same token-row
 * lock while it projects, so a token edit and a profile edit cannot interleave
 * into a cache that disagrees with the token row.
 */
export async function rebindProfilePublicMetadataToTokenDecimals(
  db: AppDb,
  params: {
    organizationId: string;
    projectId: string;
    tokenId: string;
    tokenDecimals: number;
  }
): Promise<void> {
  const repo = createPostgresAssetProfilesRepository(db);
  const profile = await repo.getActiveAssetProfileByTokenId({
    tokenId: params.tokenId,
    organizationId: params.organizationId,
    projectId: params.projectId,
  });
  // No active profile (legacy token) — nothing cached to rebind.
  if (!profile) {
    return;
  }
  // The (category, type) pair was validated when the profile was written; if it
  // no longer resolves in the registry, leave the cache untouched rather than
  // wiping it to an empty projection or failing the token edit.
  if (!getAssetTypeRegistryEntry(profile.asset_category, profile.asset_type)) {
    return;
  }
  const publicMetadata = projectPublicMetadata(
    profile.asset_category,
    profile.asset_type,
    profile.issuance_metadata,
    { tokenDecimals: params.tokenDecimals }
  );
  await repo.updateAssetProfile({
    profileId: profile.id,
    organizationId: params.organizationId,
    projectId: params.projectId,
    publicMetadata,
  });
}
