import type { ThemeScope } from "@/components/theme-scope";

// The Private Channels connect form, with or without an instance: /private-channels/setup and
// /private-channels/<instanceId>/setup. The rest of Private Channels keeps the base design.
const PRIVACY_SETUP_ROUTE = /^\/dashboard\/integrations\/private-channels\/(?:[^/]+\/)?setup\/?$/;

// The Wallets list and the create flow, under both the current and the legacy custody prefix. A
// wallet's own pages keep the base design.
const WALLETS_ROUTE = /^\/dashboard\/(?:wallets|custody)(?:\/setup)?\/?$/;

/**
 * The design-token theme scope a dashboard route's page renders in. The Overview, Payments, the
 * Wallets list and its create flow, and the Privacy connect form are built on the 2026 refresh
 * design's components and page layout; every other route keeps the base components and layout.
 * The palette, faces and sidebar are the same on every route (tokens.css, and the sidebar
 * carries the scope itself).
 *
 * @param pathname - The dashboard route.
 * @returns The scope, or null for the base design.
 */
export function themeScopeForPath(pathname: string): ThemeScope | null {
  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    return "refresh";
  }
  if (pathname === "/dashboard/payments" || pathname.startsWith("/dashboard/payments/")) {
    return "refresh";
  }
  return PRIVACY_SETUP_ROUTE.test(pathname) || WALLETS_ROUTE.test(pathname) ? "refresh" : null;
}
