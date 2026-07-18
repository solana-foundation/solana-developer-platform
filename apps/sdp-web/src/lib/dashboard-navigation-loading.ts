export const DASHBOARD_SIDE_NAV_HREFS = {
  home: "/dashboard",
  wallets: "/dashboard/wallets",
  issuance: "/dashboard/issuance",
  payments: "/dashboard/payments",
  apiKeys: "/dashboard/api-keys",
  policies: "/dashboard/policies",
  approvals: "/dashboard/approvals",
  settings: "/dashboard/settings",
} as const;

export const DASHBOARD_PAYMENTS_SUBNAV_HREFS = {
  counterparty: "/dashboard/payments/counterparty",
  pay: "/dashboard/payments/pay",
  deposit: "/dashboard/payments/deposit",
  requests: "/dashboard/payments/requests",
  recurring: "/dashboard/payments/recurring",
} as const;

export type DashboardLoadingSurface =
  | "home"
  | "wallets"
  | "issuance"
  | "payments"
  | "counterparty"
  | "api-keys"
  | "policies"
  | "approvals"
  | "members"
  | "settings"
  | "allowlist";

type DashboardLoadingContract = {
  basePath: string;
  surface: DashboardLoadingSurface;
};

// Keep the specific Payments branch before its parent. Every entry corresponds to
// a visible dashboard destination and resolves to an existing route loading UI.
const DASHBOARD_LOADING_CONTRACTS: readonly DashboardLoadingContract[] = [
  { basePath: DASHBOARD_PAYMENTS_SUBNAV_HREFS.counterparty, surface: "counterparty" },
  { basePath: DASHBOARD_SIDE_NAV_HREFS.payments, surface: "payments" },
  { basePath: DASHBOARD_SIDE_NAV_HREFS.wallets, surface: "wallets" },
  { basePath: "/dashboard/custody", surface: "wallets" },
  { basePath: DASHBOARD_SIDE_NAV_HREFS.issuance, surface: "issuance" },
  { basePath: DASHBOARD_SIDE_NAV_HREFS.apiKeys, surface: "api-keys" },
  { basePath: DASHBOARD_SIDE_NAV_HREFS.policies, surface: "policies" },
  { basePath: DASHBOARD_SIDE_NAV_HREFS.approvals, surface: "approvals" },
  { basePath: "/dashboard/members", surface: "members" },
  { basePath: DASHBOARD_SIDE_NAV_HREFS.settings, surface: "settings" },
  { basePath: "/dashboard/allowlist", surface: "allowlist" },
];

function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

function isRouteAtOrBelow(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

export function resolveDashboardLoadingSurface(
  rawPathname: string
): DashboardLoadingSurface | null {
  const pathname = normalizePathname(rawPathname);
  if (pathname === DASHBOARD_SIDE_NAV_HREFS.home) return "home";

  return (
    DASHBOARD_LOADING_CONTRACTS.find((contract) => isRouteAtOrBelow(pathname, contract.basePath))
      ?.surface ?? null
  );
}

export type DashboardNavigationIntentInput = {
  currentHref: string;
  targetHref: string;
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: string | null;
  download?: boolean;
};

export const DASHBOARD_NAVIGATION_START_EVENT = "sdp:dashboard-navigation-start";
export const DASHBOARD_NAVIGATION_RECOVERY_TIMEOUT_MS = 10_000;

export type DashboardNavigationStartDetail = {
  fromPathname: string;
  toPathname: string;
};

/**
 * Resolves a normal same-tab dashboard click to the pathname whose loading UI
 * should be shown immediately. Modified, external, same-route, and unsupported
 * links intentionally keep their native behavior without changing the shell.
 */
export function resolveDashboardNavigationIntent({
  currentHref,
  targetHref,
  button = 0,
  metaKey = false,
  ctrlKey = false,
  shiftKey = false,
  altKey = false,
  target,
  download = false,
}: DashboardNavigationIntentInput): string | null {
  if (
    button !== 0 ||
    metaKey ||
    ctrlKey ||
    shiftKey ||
    altKey ||
    download ||
    (target && target !== "_self")
  ) {
    return null;
  }

  let currentUrl: URL;
  let targetUrl: URL;
  try {
    currentUrl = new URL(currentHref);
    targetUrl = new URL(targetHref, currentUrl);
  } catch {
    return null;
  }

  if (targetUrl.origin !== currentUrl.origin) return null;

  const targetPathname = normalizePathname(targetUrl.pathname);
  const currentPathname = normalizePathname(currentUrl.pathname);
  if (targetPathname === currentPathname) return null;
  if (!resolveDashboardLoadingSurface(targetPathname)) return null;

  return targetPathname;
}

/** Announces programmatic router navigation to the shell before the RSC request starts. */
export function announceDashboardNavigation(targetHref: string): void {
  if (typeof window === "undefined") return;

  const toPathname = resolveDashboardNavigationIntent({
    currentHref: window.location.href,
    targetHref,
  });
  if (!toPathname) return;

  window.dispatchEvent(
    new CustomEvent<DashboardNavigationStartDetail>(DASHBOARD_NAVIGATION_START_EVENT, {
      detail: {
        fromPathname: window.location.pathname,
        toPathname,
      },
    })
  );
}
