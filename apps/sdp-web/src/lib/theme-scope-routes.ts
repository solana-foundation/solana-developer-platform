import type { ThemeScope } from "@/components/theme-scope";

// The Private Channels connect form, with or without an instance: /private-channels/setup and
// /private-channels/<instanceId>/setup. The rest of Private Channels keeps the base design.
const PRIVACY_SETUP_ROUTE = /^\/dashboard\/integrations\/private-channels\/(?:[^/]+\/)?setup\/?$/;

// The Payments pages redesigned so far: Contacts (the list, a new contact, one contact's page).
const PAYMENTS_REFRESH_ROUTE = /^\/dashboard\/payments\/counterparty(?:\/[^/]+)?\/?$/;

/**
 * Whether a Payments route is one NEW DESIGN has redesigned so far. The rest of Payments keeps
 * the previous design, flag or no flag.
 *
 * @param pathname - The dashboard route.
 * @returns True for Contacts.
 */
export function isRedesignedPaymentsPath(pathname: string): boolean {
  return PAYMENTS_REFRESH_ROUTE.test(pathname);
}

/**
 * The design-token theme scope a dashboard route renders in. Payments' Contacts and the Privacy
 * connect form are built on the 2026 refresh design; every other route keeps the base design.
 * With NEW DESIGN off, every route keeps the base design.
 *
 * @param pathname - The dashboard route.
 * @param newDesign - Whether the page renders in the new design (isNewDesignPage).
 * @returns The scope, or null for the base design.
 */
export function themeScopeForPath(pathname: string, newDesign = true): ThemeScope | null {
  if (!newDesign) {
    return null;
  }
  return isRedesignedPaymentsPath(pathname) || PRIVACY_SETUP_ROUTE.test(pathname)
    ? "refresh"
    : null;
}
