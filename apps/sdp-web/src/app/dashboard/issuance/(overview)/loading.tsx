import { getAssetProfilesDefault } from "@/lib/feature-flag-defaults";
import { IssuancePageSkeleton } from "../issuance-page-skeleton";

// A Suspense fallback can't await the async `assetProfiles()` flag — a fallback
// that suspends never paints — so mirror the flag's own `defaultValue` inputs
// (see src/flags.ts) to pick the matching skeleton. Without this the fallback
// always rendered the legacy grid and then swapped to the asset-profile grid.
// Only a per-user/team Vercel override can still diverge from the live page.
const assetProfilesEnabled = getAssetProfilesDefault({
  assetProfilesEnabled: process.env.ASSET_PROFILES_ENABLED,
  nodeEnvironment: process.env.NODE_ENV,
  sdpEnvironment: process.env.NEXT_PUBLIC_SDP_ENVIRONMENT,
  vercelEnvironment: process.env.VERCEL_ENV,
});

export default function IssuanceLoading() {
  return <IssuancePageSkeleton assetProfilesEnabled={assetProfilesEnabled} />;
}
