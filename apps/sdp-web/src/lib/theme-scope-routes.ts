import type { ThemeScope } from "@/components/theme-scope";

// The Private Channels connect form, with or without an instance: /private-channels/setup and
// /private-channels/<instanceId>/setup. The rest of Private Channels keeps the base design.
const PRIVACY_SETUP_ROUTE = /^\/dashboard\/integrations\/private-channels\/(?:[^/]+\/)?setup\/?$/;

/**
 * The design-token theme scope a dashboard route renders in. Payments and the Privacy connect
 * form are built on the 2026 refresh design; every other route keeps the base design.
 *
 * @param pathname - The dashboard route.
 * @returns The scope, or null for the base design.
 */
export function themeScopeForPath(pathname: string): ThemeScope | null {
  if (pathname === "/dashboard/payments" || pathname.startsWith("/dashboard/payments/")) {
    return "refresh";
  }
  return PRIVACY_SETUP_ROUTE.test(pathname) ? "refresh" : null;
}
