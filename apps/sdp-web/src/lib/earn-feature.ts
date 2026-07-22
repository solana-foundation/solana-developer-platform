// Frontend gate for the Earn (SDP Markets) UI: the sidebar nav item, the
// /dashboard/markets/earn overview, and the /dashboard/markets/earn/deposit wizard.
// Independent of the backend EARN_ENABLED flag on sdp-api — this only controls
// whether the UI is shown, while the API enforces its own flag on every
// request. Toggle per environment/branch via NEXT_PUBLIC_EARN_ENABLED (e.g. in
// Vercel's Preview scope).
//
// Unlike the asset-profiles gate, this defaults ON in local development: the
// current Earn surface is a mock-data design preview meant to be explored via
// `pnpm dev:web` without extra env setup. Deployed environments always require
// the explicit flag.
export function isEarnUiEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_EARN_ENABLED === "true") {
    return true;
  }
  return process.env.NODE_ENV === "development";
}
