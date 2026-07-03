// Frontend gate for the Asset Profiles issuance UI (the full-page create
// wizard under /dashboard/issuance/create). Independent of the backend
// ASSET_PROFILES_ENABLED flag on sdp-api: this only controls whether the UI is
// shown, while the API still enforces its own flag on every request. Both must
// be enabled for the feature to work end-to-end. Toggle per environment/branch
// via NEXT_PUBLIC_ASSET_PROFILES_ENABLED (e.g. in Vercel's Preview scope).
export function isAssetProfilesUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ASSET_PROFILES_ENABLED === "true";
}
