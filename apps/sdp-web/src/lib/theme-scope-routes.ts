import type { ThemeScope } from "@/components/theme-scope";
import { designModuleForPath } from "@/lib/design-modules";

// The Private Channels connect form, with or without an instance: /private-channels/setup and
// /private-channels/<instanceId>/setup. The rest of Private Channels keeps the base design.
const PRIVACY_SETUP_ROUTE = /^\/dashboard\/integrations\/private-channels\/(?:[^/]+\/)?setup\/?$/;

/**
 * The design-token theme scope a dashboard route renders in. Every design module's routes
 * (lib/design-modules.ts) and the Privacy connect form are built on the 2026 refresh design;
 * every other route keeps the base design. A page on the previous design (NEW DESIGN or its
 * module's flag off) keeps the base design.
 *
 * @param pathname - The dashboard route.
 * @param newDesign - Whether the page renders in the new design (isNewDesignPage).
 * @returns The scope, or null for the base design.
 */
export function themeScopeForPath(pathname: string, newDesign = true): ThemeScope | null {
  if (!newDesign) {
    return null;
  }
  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    return "refresh";
  }
  return designModuleForPath(pathname) !== null || PRIVACY_SETUP_ROUTE.test(pathname)
    ? "refresh"
    : null;
}
