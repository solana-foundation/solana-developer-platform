import type { ThemeScope } from "@sdp/ui/theme-scope";

/**
 * The dashboard routes built on the 2026 refresh design's tokens. Every other route keeps the base
 * design's tokens.
 */
const REFRESH_ROUTES = [
  // The dashboard's Overview, and the quick start it shares with the sidebar and Settings.
  /^\/dashboard\/?$/,
  // The Wallets list, its create flow and one wallet's page, under both the current and the
  // legacy custody prefix. A wallet's policy editor and audit pages keep the base design.
  // `connections` and `switch` are pages of their own, not wallets.
  /^\/dashboard\/(?:wallets|custody)(?:\/(?!connections\/?$|switch\/?$)[^/]+)?\/?$/,
  // Issuance: the token list and its API playground, the draft flow and one token's page.
  /^\/dashboard\/issuance(?:\/|$)/,
  // Payments: every page.
  /^\/dashboard\/payments(?:\/|$)/,
  // Markets: the landing that routes to Earn's surfaces and DvP, and Treasury. DvP's own pages
  // keep the base design.
  /^\/dashboard\/markets(?:\/treasury-solutions)?\/?$/,
  // The Private Channels connect form, with or without an instance: /private-channels/setup and
  // /private-channels/<instanceId>/setup. The rest of Private Channels keeps the base design.
  /^\/dashboard\/integrations\/private-channels\/(?:[^/]+\/)?setup\/?$/,
] as const;

/**
 * The design-token theme scope a dashboard route renders in.
 *
 * @param pathname - The dashboard route.
 * @returns The scope, or null for the base design.
 */
export function themeScopeForPath(pathname: string): ThemeScope | null {
  return REFRESH_ROUTES.some((route) => route.test(pathname)) ? "refresh" : null;
}
