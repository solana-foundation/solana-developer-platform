// Frontend gate for the Asset Profiles issuance UI. Controls two surfaces:
//   1. The full-page create wizard at /dashboard/issuance/create.
//   2. The per-token AssetManagementWorkspace at /dashboard/issuance/[tokenId].
// Independent of the backend ASSET_PROFILES_ENABLED flag on sdp-api: this only
// controls whether the UI is shown. Recognized non-production contexts are
// always enabled; production keeps the explicit flag for a controlled rollout.
export function isAssetProfilesUiEnabled(): boolean {
  const sdpEnvironment = process.env.NEXT_PUBLIC_SDP_ENVIRONMENT?.trim().toLowerCase();
  if (sdpEnvironment === "development") {
    return true;
  }

  const vercelEnvironment = process.env.NEXT_PUBLIC_VERCEL_ENV?.trim().toLowerCase();
  if (vercelEnvironment === "preview" || vercelEnvironment === "development") {
    return true;
  }

  const nodeEnvironment = process.env.NODE_ENV?.trim().toLowerCase();
  if (
    !sdpEnvironment &&
    !vercelEnvironment &&
    (nodeEnvironment === "development" || nodeEnvironment === "test")
  ) {
    return true;
  }

  const explicitFlag = process.env.NEXT_PUBLIC_ASSET_PROFILES_ENABLED?.trim().toLowerCase();
  return explicitFlag === "true";
}
