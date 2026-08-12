import type { AssetCategory, SelectedSetting, StoredAdvancedSettings } from "@sdp/types";
import { getDb } from "@/db";
import { createAssetProfilesRepository } from "@/db/repositories";
import { createTenantScope } from "@/lib/tenant-scope";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

export interface AssetGateContext {
  category: AssetCategory;
  type: string;
  selectedSettings: Record<string, SelectedSetting>;
  hasAllowlist: boolean;
  // Whether the token can still be minted. `mint`/`burn` are `base`-kind actions with
  // no advanced-setting gate, so without this a mint rule saves cleanly (and previews
  // green) on a token whose mint authority was revoked.
  isMintable: boolean;
}

// Resolve the capability-gate inputs for a token: its (category, type) + enabled
// advanced settings (from the active asset profile) + whether it has an allowlist.
// Env-based (no HTTP context) so it serves both the save-time route handler and the
// execution-time cron engine (which has no request).
export async function resolveAssetGateContext(
  env: Env,
  params: { tokenId: string; organizationId: string; projectId: string }
): Promise<AssetGateContext | null> {
  // The caller's org/project are the trusted tenant identity — from the authenticated
  // request on the save path, from the enqueue-time execution row on the engine path.
  const scope = createTenantScope({
    organizationId: params.organizationId,
    projectId: params.projectId,
  });
  const token = await new TokenService(getDb(env), scope).getToken(params);
  if (!token) {
    return null;
  }
  const profile = await createAssetProfilesRepository(env, scope).getActiveAssetProfileByTokenId(
    params
  );
  const stored = profile?.issuance_metadata?.settings as StoredAdvancedSettings | undefined;
  return {
    category: (profile?.asset_category ?? "generic") as AssetCategory,
    type: profile?.asset_type ?? "generic",
    selectedSettings: stored?.selected ?? {},
    hasAllowlist: Boolean(token.ablListAddress),
    isMintable: Boolean(token.isMintable && token.mintAuthority),
  };
}
