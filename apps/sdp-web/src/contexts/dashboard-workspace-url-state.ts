const PLAYGROUND_TAB_PATHS = new Set([
  "/dashboard/issuance",
  "/dashboard/payments",
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
