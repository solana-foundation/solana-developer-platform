import type { ThemeScope } from "@/components/theme-scope";

// The Private Channels connect form, with or without an instance: /private-channels/setup and
// /private-channels/<instanceId>/setup. The rest of Private Channels keeps the base design.
const PRIVACY_SETUP_ROUTE = /^\/dashboard\/integrations\/private-channels\/(?:[^/]+\/)?setup\/?$/;

/**
 * The design-token theme scope a dashboard route renders in. The Privacy connect form is built
 * on the 2026 refresh design; every other route keeps the base design. With NEW DESIGN off,
 * every route keeps the base design.
 *
 * @param pathname - The dashboard route.
 * @param newDesign - Whether the NEW DESIGN flag is on.
 * @returns The scope, or null for the base design.
 */
export function themeScopeForPath(pathname: string, newDesign = true): ThemeScope | null {
  if (!newDesign) {
    return null;
  }
  return PRIVACY_SETUP_ROUTE.test(pathname) ? "refresh" : null;
}
