const PLAYGROUND_TAB_PATHS = new Set([
  "/dashboard/issuance",
  "/dashboard/payments",
  // Private Channels serves its playground as a tab on the overview route, so
  // a cross-route jump and the legacy /api-playground redirect both land here
  // carrying tab=playground. Without this entry the tab is stripped on the
  // pathname change and the destination silently reverts to Overview.
  "/dashboard/integrations/private-channels/overview",
]);

// The previous design (NEW DESIGN off) also serves Counterparty's and Requests' playgrounds as
// tabs on their own routes; the new design folds them into the Payments playground.
const LEGACY_DESIGN_PLAYGROUND_TAB_PATHS = new Set([
  "/dashboard/payments/counterparty",
  "/dashboard/payments/requests",
]);

function normalizePathname(pathname: string): string {
  return pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
}

/**
 * Keeps an explicit playground destination intact when a pathname transition
 * commits. Other tab values still get removed so route-local state cannot leak
 * into dashboard pages that do not own it.
 */
export function shouldClearDashboardTabAfterPathnameChange({
  previousPathname,
  pathname,
  tab,
  newDesign = true,
}: {
  previousPathname: string;
  pathname: string;
  tab: string | null;
  newDesign?: boolean;
}): boolean {
  if (normalizePathname(previousPathname) === normalizePathname(pathname) || !tab) {
    return false;
  }

  const destination = normalizePathname(pathname);
  const keepsPlaygroundTab =
    PLAYGROUND_TAB_PATHS.has(destination) ||
    (!newDesign && LEGACY_DESIGN_PLAYGROUND_TAB_PATHS.has(destination));
  return tab !== "playground" || !keepsPlaygroundTab;
}
