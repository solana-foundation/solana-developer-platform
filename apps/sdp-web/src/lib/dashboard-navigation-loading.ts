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

export type DashboardLoadingRoute =
  | "home"
  | "wallets-overview"
  | "wallet-setup"
  | "wallet-detail"
  | "wallet-policy"
  | "wallet-policy-audit-list"
  | "wallet-policy-audit-detail"
  | "wallet-policy-revisions"
  | "issuance-overview"
  | "issuance-create"
  | "issuance-detail"
  | "payments-overview"
  | "payments-pay"
  | "payments-deposit"
  | "payment-requests"
  | "counterparty-directory"
  | "counterparty-create"
  | "counterparty-detail"
  | "recurring-payments"
  | "recurring-payment-create"
  | "recurring-payment-detail"
  | "api-keys-list"
  | "api-key-new"
  | "api-key-edit"
  | "policies"
  | "approvals-list"
  | "approval-detail"
  | "members"
  | "settings"
  | "allowlist";

function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

function resolveWalletLoadingRoute(pathname: string): DashboardLoadingRoute | null {
  const prefix =
    pathname === "/dashboard/custody" || pathname.startsWith("/dashboard/custody/")
      ? "/dashboard/custody"
      : pathname === "/dashboard/wallets" || pathname.startsWith("/dashboard/wallets/")
        ? "/dashboard/wallets"
        : null;
  if (!prefix) return null;
  if (pathname === prefix) return "wallets-overview";
  if (pathname === `${prefix}/setup` || pathname === `${prefix}/switch`) return "wallet-setup";

  const suffix = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (suffix.length < 1) return null;
  if (suffix[1] !== "policy") return "wallet-detail";
  if (suffix.length === 2) return "wallet-policy";
  if (suffix[2] === "revisions" && suffix.length === 3) return "wallet-policy-revisions";
  if (suffix[2] === "audit" && suffix.length === 3) return "wallet-policy-audit-list";
  if (suffix[2] === "audit" && suffix.length === 4) return "wallet-policy-audit-detail";
  return null;
}

/** Resolves a dashboard pathname to the exact canonical route loading surface. */
export function resolveDashboardLoadingRoute(rawPathname: string): DashboardLoadingRoute | null {
  const pathname = normalizePathname(rawPathname);
  if (pathname === "/dashboard") return "home";

  const walletRoute = resolveWalletLoadingRoute(pathname);
  if (walletRoute) return walletRoute;

  if (pathname === "/dashboard/issuance") return "issuance-overview";
  if (pathname === "/dashboard/issuance/create") return "issuance-create";
  if (/^\/dashboard\/issuance\/[^/]+$/.test(pathname)) return "issuance-detail";

  if (pathname === "/dashboard/payments") return "payments-overview";
  if (pathname === "/dashboard/payments/pay") return "payments-pay";
  if (pathname === "/dashboard/payments/deposit") return "payments-deposit";
  if (pathname === "/dashboard/payments/requests") return "payment-requests";
  if (pathname === "/dashboard/payments/counterparty") return "counterparty-directory";
  if (pathname === "/dashboard/payments/counterparty/create") return "counterparty-create";
  if (/^\/dashboard\/payments\/counterparty\/[^/]+$/.test(pathname)) {
    return "counterparty-detail";
  }
  if (pathname === "/dashboard/payments/recurring") return "recurring-payments";
  if (pathname === "/dashboard/payments/recurring/create") return "recurring-payment-create";
  if (/^\/dashboard\/payments\/recurring\/[^/]+$/.test(pathname)) {
    return "recurring-payment-detail";
  }

  if (pathname === "/dashboard/api-keys") return "api-keys-list";
  if (pathname === "/dashboard/api-keys/new") return "api-key-new";
  if (/^\/dashboard\/api-keys\/[^/]+\/edit$/.test(pathname)) return "api-key-edit";
  if (pathname === "/dashboard/policies") return "policies";
  if (pathname === "/dashboard/approvals") return "approvals-list";
  if (/^\/dashboard\/approvals\/[^/]+$/.test(pathname)) return "approval-detail";
  if (pathname === "/dashboard/members") return "members";
  if (pathname === "/dashboard/settings") return "settings";
  if (pathname === "/dashboard/allowlist") return "allowlist";

  return null;
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
 * links keep their native behavior without changing the shell.
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
  if (!resolveDashboardLoadingRoute(targetPathname)) return null;

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
