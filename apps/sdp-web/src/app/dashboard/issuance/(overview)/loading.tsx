import { IssuancePageSkeleton } from "../issuance-page-skeleton";

/**
 * Issuance overview Suspense fallback. It can't await the async
 * `assetProfiles()` flag — a fallback that suspends never paints — so it
 * mirrors the flag's static `defaultValue: true` (keep in sync with
 * src/flags.ts). Only a Vercel dashboard rule or override can diverge from it.
 *
 * @returns The issuance page skeleton matching the flag default.
 */
export default function IssuanceLoading() {
  return <IssuancePageSkeleton assetProfilesEnabled />;
}
