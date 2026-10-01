const PLAYGROUND_TAB_PATHS = new Set([
  "/dashboard/issuance",
  "/dashboard/payments",
  "/dashboard/payments/counterparty",
  "/dashboard/payments/requests",
  // Private Channels serves its playground as a tab on the overview route, so
  // a cross-route jump and the legacy /api-playground redirect both land here
  // carrying tab=playground. Without this entry the tab is stripped on the
  // pathname change and the destination silently reverts to Overview.
  "/dashboard/integrations/private-channels/overview",
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
}: {
  previousPathname: string;
  pathname: string;
  tab: string | null;
}): boolean {
  if (normalizePathname(previousPathname) === normalizePathname(pathname) || !tab) {
    return false;
  }

  return tab !== "playground" || !PLAYGROUND_TAB_PATHS.has(normalizePathname(pathname));
}
