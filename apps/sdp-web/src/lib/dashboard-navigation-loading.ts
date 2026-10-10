export const DASHBOARD_SIDE_NAV_HREFS = {
  home: "/dashboard",
  wallets: "/dashboard/wallets",
  issuance: "/dashboard/issuance",
  payments: "/dashboard/payments",
  markets: "/dashboard/markets",
  heliusRings: "/dashboard/helius-rings",
  apiKeys: "/dashboard/api-keys",
  settings: "/dashboard/settings",
  integrations: "/dashboard/integrations",
} as const;

export const DASHBOARD_MARKETS_SUBNAV_HREFS = {
  treasurySolutions: "/dashboard/markets/treasury-solutions",
  earnProgram: "/dashboard/markets/embedded-yield",
  dvp: "/dashboard/markets/dvp",
} as const;

export const DASHBOARD_PAYMENTS_SUBNAV_HREFS = {
  transactions: "/dashboard/payments/transactions",
  counterparty: "/dashboard/payments/counterparty",
  pay: "/dashboard/payments/pay",
  deposit: "/dashboard/payments/deposit",
  requests: "/dashboard/payments/requests",
  recurring: "/dashboard/payments/recurring",
} as const;

export const DASHBOARD_INTEGRATIONS_SUBNAV_HREFS = {
  custody: "/dashboard/integrations?tab=custody",
  ramps: "/dashboard/integrations?tab=ramps",
  compliance: "/dashboard/integrations?tab=compliance",
  privacy: "/dashboard/integrations?tab=privacy",
} as const;

export type DashboardLoadingRoute =
  | "home"
  | "token-holdings"
  | "wallets-overview"
  | "wallet-setup"
  | "wallet-connections"
  | "wallet-detail"
  | "issuance-overview"
  | "issuance-create"
  | "issuance-detail"
  | "payments-overview"
  | "markets-landing"
  | "treasury-solutions"
  | "embedded-yield-portfolio"
  | "embedded-yield-configure"
  | "embedded-yield-integrate"
  | "dvp-trades"
  | "dvp-trade-create"
  | "dvp-trade-detail"
  | "payments-transactions"
  | "payment-transaction-detail"
  | "payments-pay"
  | "payments-deposit"
  | "payment-requests"
  | "payment-request-create"
  | "payment-request-detail"
  | "counterparty-directory"
  | "counterparty-create"
  | "counterparty-detail"
  | "recurring-payments"
  | "recurring-payment-create"
  | "recurring-payment-detail"
  | "api-keys-list"
  | "api-key-new"
  | "api-key-edit"
  | "settings"
  | "integrations"
  | "integration-detail"
  | "private-channels-setup"
  | "helius-rings"
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
  if (pathname === `${prefix}/setup`) return "wallet-setup";
  if (pathname === `${prefix}/connections`) return "wallet-connections";

  const suffix = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (suffix.length < 1) return null;
  return "wallet-detail";
}

function resolveMarketsLoadingRoute(pathname: string): DashboardLoadingRoute | null {
  if (pathname === DASHBOARD_SIDE_NAV_HREFS.markets) {
    return "markets-landing";
  }
  if (pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.treasurySolutions) {
    return "treasury-solutions";
  }
  if (pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram) return "embedded-yield-portfolio";
  if (pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/configure`) {
    return "embedded-yield-configure";
  }
  if (pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/integrate`) {
    return "embedded-yield-integrate";
  }
  if (pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.dvp) return "dvp-trades";
  // Before the detail arm: /dvp/create would otherwise match its id pattern.
  if (pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/create`) return "dvp-trade-create";
  // Detail routes need their own arm: every other markets match is exact, so a
  // trade id would resolve to no loading key and fall back to the home skeleton.
  if (new RegExp(`^${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/[^/]+$`).test(pathname)) {
    return "dvp-trade-detail";
  }
  return null;
}

function resolveOperationsLoadingRoute(pathname: string): DashboardLoadingRoute | null {
  if (pathname === "/dashboard/api-keys") return "api-keys-list";
  if (pathname === "/dashboard/api-keys/new") return "api-key-new";
  if (/^\/dashboard\/api-keys\/[^/]+\/edit$/.test(pathname)) return "api-key-edit";
  // Members only redirects into Settings, so it loads as the page it lands on.
  if (pathname === "/dashboard/settings" || pathname === "/dashboard/members") return "settings";
  return null;
}

/** Resolves a dashboard pathname to the exact canonical route loading surface. */
export function resolveDashboardLoadingRoute(rawPathname: string): DashboardLoadingRoute | null {
  const pathname = normalizePathname(rawPathname);
  if (pathname === "/dashboard") return "home";
  if (pathname === "/dashboard/tokens") return "token-holdings";

  const walletRoute = resolveWalletLoadingRoute(pathname);
  if (walletRoute) return walletRoute;

  if (pathname === "/dashboard/issuance") return "issuance-overview";
  if (pathname === "/dashboard/issuance/create") return "issuance-create";
  if (/^\/dashboard\/issuance\/[^/]+$/.test(pathname)) return "issuance-detail";

  const marketsRoute = resolveMarketsLoadingRoute(pathname);
  if (marketsRoute) return marketsRoute;

  if (pathname === "/dashboard/payments") return "payments-overview";
  if (pathname === "/dashboard/payments/transactions") return "payments-transactions";
  if (pathname === "/dashboard/payments/pay") return "payments-pay";
  if (pathname === "/dashboard/payments/deposit") return "payments-deposit";
  if (pathname === "/dashboard/payments/requests") return "payment-requests";
  if (pathname === "/dashboard/payments/requests/new") return "payment-request-create";
  if (/^\/dashboard\/payments\/requests\/[^/]+$/.test(pathname)) return "payment-request-detail";
  if (/^\/dashboard\/payments\/transactions\/[^/]+$/.test(pathname)) {
    return "payment-transaction-detail";
  }
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

  const operationsRoute = resolveOperationsLoadingRoute(pathname);
  if (operationsRoute) return operationsRoute;

  if (pathname === DASHBOARD_SIDE_NAV_HREFS.heliusRings) return "helius-rings";
  if (pathname === "/dashboard/integrations") return "integrations";
  if (pathname === "/dashboard/integrations/private-channels/setup") {
    return "private-channels-setup";
  }
  if (pathname.startsWith("/dashboard/integrations/private-channels")) {
    return "integration-detail";
  }
  if (/^\/dashboard\/integrations\/[^/]+$/.test(pathname)) return "integration-detail";
  if (pathname === "/dashboard/allowlist") return "allowlist";

  return null;
}

/**
 * Whether a top-level nav destination is the one currently being viewed.
 *
 * Lives here rather than in the shell so the sidebar and the mobile bottom bar
 * cannot drift apart on which tab is highlighted. Wallets deliberately claims the
 * `/dashboard/custody` tree too — they are the same destination under two paths.
 */
export function isDashboardNavItemActive(pathname: string, href: string): boolean {
  const [pathnameOnly, pathnameSearch = ""] = pathname.split("?", 2);
  const [hrefPathname, hrefSearch] = href.split("?", 2);

  // Integration family links intentionally keep the reader on the catalog and
  // change only its `tab` query parameter. Match that parameter exactly so
  // just one child in the sidebar earns the active rail treatment.
  if (hrefSearch) {
    return pathnameOnly === hrefPathname && pathnameSearch === hrefSearch;
  }

  if (href === "/dashboard") {
    // Holdings has no nav entry of its own and is only reached from the home
    // allocation card, so Home keeps the highlight rather than the sidebar going
    // blank while you are on it.
    return pathnameOnly === "/dashboard" || pathnameOnly === "/dashboard/tokens";
  }
  if (href === "/dashboard/integrations") {
    return (
      pathnameOnly === "/dashboard/integrations" ||
      pathnameOnly.startsWith("/dashboard/integrations/")
    );
  }
  if (href === "/dashboard/wallets") {
    return (
      pathnameOnly.startsWith("/dashboard/wallets") || pathnameOnly.startsWith("/dashboard/custody")
    );
  }
  if (href === "/dashboard/payments") {
    return (
      pathnameOnly === "/dashboard/payments" || pathnameOnly.startsWith("/dashboard/payments/")
    );
  }
  return pathnameOnly === href || pathnameOnly.startsWith(`${href}/`);
}

const PROJECT_SWITCH_DESTINATIONS = [
  ...Object.values(DASHBOARD_MARKETS_SUBNAV_HREFS),
  ...Object.values(DASHBOARD_PAYMENTS_SUBNAV_HREFS),
  ...Object.values(DASHBOARD_SIDE_NAV_HREFS),
];

/**
 * Where switching Project lands from the current page: the root of the module
 * (or sub-module) the page belongs to, never the page itself, because ids in
 * the path (wallets, tokens, trades) belong to the Project being left.
 *
 * @param dashboardPath - Project-less path of the current page, e.g. `/dashboard/custody/cwlt_1`.
 * @returns The module root to open under the other Project, e.g. `/dashboard/wallets`.
 */
export function projectSwitchDestination(dashboardPath: string): string {
  const destination = PROJECT_SWITCH_DESTINATIONS.find(
    (href) =>
      href !== DASHBOARD_SIDE_NAV_HREFS.home && isDashboardNavItemActive(dashboardPath, href)
  );
  return destination === undefined ? DASHBOARD_SIDE_NAV_HREFS.home : destination;
}
