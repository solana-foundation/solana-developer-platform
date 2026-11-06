import { SETTINGS_TABS } from "@/app/(session)/dashboard/[projectId]/settings/settings-tabs";
import { DASHBOARD_SIDE_NAV_HREFS } from "@/lib/dashboard-navigation-loading";

const PLAYGROUND_TAB = ["playground"];

/**
 * The `?tab=` values each route owns, so a link that names one keeps it when
 * the pathname changes. Any other tab is dropped.
 */
const ROUTE_TABS = new Map<string, readonly string[]>([
  ["/dashboard/issuance", PLAYGROUND_TAB],
  ["/dashboard/payments", PLAYGROUND_TAB],
  [
    DASHBOARD_SIDE_NAV_HREFS.integrations,
    ["custody", "rpc", "ramps", "compliance", "private_channels"],
  ],
  // Organization settings serves General, Members and Security as ?tab= tabs of one page.
  ["/dashboard/settings", SETTINGS_TABS.map((settingsTab) => settingsTab.id)],
]);

function normalizePathname(pathname: string): string {
  return pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
}

/**
 * Keeps an explicit tab destination intact when a pathname transition commits.
 * Tabs the destination route does not own are removed so route-local state
 * cannot leak into dashboard pages that do not own it.
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

  const destination = normalizePathname(pathname);
  const ownsTab = ROUTE_TABS.get(destination)?.includes(tab);
  return !ownsTab;
}
