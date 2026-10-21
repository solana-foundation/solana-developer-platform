import {
  DASHBOARD_INTEGRATIONS_SUBNAV_HREFS,
  DASHBOARD_SIDE_NAV_HREFS,
} from "@/lib/dashboard-navigation-loading";

const PLAYGROUND_TAB = ["playground"];

/**
 * The `?tab=` values each route owns, so a link that names one keeps it when
 * the pathname changes. Any other tab is dropped.
 */
const ROUTE_TABS = new Map<string, readonly string[]>([
  ["/dashboard/issuance", PLAYGROUND_TAB],
  ["/dashboard/payments", PLAYGROUND_TAB],
  // Private Channels serves its playground as a tab on the overview route, so
  // a cross-route jump and the legacy /api-playground redirect both land here
  // carrying tab=playground. Without this entry the tab is stripped on the
  // pathname change and the destination silently reverts to Overview.
  ["/dashboard/integrations/private-channels/overview", PLAYGROUND_TAB],
  // The Integrations sidebar submenu links to the hub with a family tab.
  [DASHBOARD_SIDE_NAV_HREFS.integrations, Object.keys(DASHBOARD_INTEGRATIONS_SUBNAV_HREFS)],
]);

// The previous design also serves Counterparty's and Requests' playgrounds as tabs on their own
// routes; the new design folds them into the Payments playground.
const LEGACY_DESIGN_ROUTE_TABS = new Map<string, readonly string[]>([
  ["/dashboard/payments/counterparty", PLAYGROUND_TAB],
  ["/dashboard/payments/requests", PLAYGROUND_TAB],
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
  newDesign = true,
}: {
  previousPathname: string;
  pathname: string;
  tab: string | null;
  /** Whether the destination page renders in the new design (isNewDesignPage). */
  newDesign?: boolean;
}): boolean {
  if (normalizePathname(previousPathname) === normalizePathname(pathname) || !tab) {
    return false;
  }

  const destination = normalizePathname(pathname);
  const ownsTab =
    ROUTE_TABS.get(destination)?.includes(tab) ||
    (!newDesign && LEGACY_DESIGN_ROUTE_TABS.get(destination)?.includes(tab));
  return !ownsTab;
}
