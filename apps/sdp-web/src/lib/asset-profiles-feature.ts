// Frontend gate for the Asset Profiles issuance UI. Controls two surfaces:
//   1. The full-page create wizard at /dashboard/issuance/create.
//   2. The per-token AssetManagementWorkspace at /dashboard/issuance/[tokenId].
// Independent of the backend ASSET_PROFILES_ENABLED flag on sdp-api: this only
// controls whether the UI is shown, while the API still enforces its own flag on
// every request. Both must be enabled for the feature to work end-to-end.
// Toggle per environment/branch via NEXT_PUBLIC_ASSET_PROFILES_ENABLED (e.g. in
// Vercel's Preview scope).
export function isAssetProfilesUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ASSET_PROFILES_ENABLED === "true";
}
