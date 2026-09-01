export const DASHBOARD_SIDE_NAV_HREFS = {
  home: "/dashboard",
  wallets: "/dashboard/wallets",
  issuance: "/dashboard/issuance",
  payments: "/dashboard/payments",
  markets: "/dashboard/markets",
  heliusRings: "/dashboard/helius-rings",
  apiKeys: "/dashboard/api-keys",
  policies: "/dashboard/policies",
  approvals: "/dashboard/approvals",
  settings: "/dashboard/settings",
  integrations: "/dashboard/integrations",
} as const;

export const DASHBOARD_MARKETS_SUBNAV_HREFS = {
  treasurySolutions: "/dashboard/markets/treasury-solutions",
  earnProgram: "/dashboard/markets/embedded-yield",
} as const;

export const DASHBOARD_PAYMENTS_SUBNAV_HREFS = {
  transactions: "/dashboard/payments/transactions",
  counterparty: "/dashboard/payments/counterparty",
  pay: "/dashboard/payments/pay",
  deposit: "/dashboard/payments/deposit",
  requests: "/dashboard/payments/requests",
  recurring: "/dashboard/payments/recurring",
} as const;

export type DashboardLoadingRoute =
  | "home"
  | "token-holdings"
  | "wallets-overview"
  | "wallet-setup"
  | "wallet-connections"
  | "wallet-detail"
  | "wallet-policy"
  | "wallet-policy-audit-list"
  | "wallet-policy-audit-detail"
  | "issuance-overview"
  | "issuance-create"
  | "issuance-detail"
  | "payments-overview"
  | "markets-landing"
  | "treasury-solutions"
  | "earn-program"
  | "payments-transactions"
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
  | "settings"
  | "integrations"
  | "integration-detail"
  | "private-channels-setup"
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
  if (pathname === `${prefix}/connections`) return "wallet-connections";

  const suffix = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (suffix.length < 1) return null;
  if (suffix[1] !== "policy") return "wallet-detail";
  if (suffix.length === 2) return "wallet-policy";
  if (suffix[2] === "audit" && suffix.length === 3) return "wallet-policy-audit-list";
  if (suffix[2] === "audit" && suffix.length === 4) return "wallet-policy-audit-detail";
  return null;
}

function resolveMarketsLoadingRoute(pathname: string): DashboardLoadingRoute | null {
  if (pathname === DASHBOARD_SIDE_NAV_HREFS.markets) {
    return "markets-landing";
  }
  if (pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.treasurySolutions) {
    return "treasury-solutions";
  }
  if (
    pathname === DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram ||
    pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/configure` ||
    pathname === `${DASHBOARD_MARKETS_SUBNAV_HREFS.earnProgram}/integrate`
  ) {
    return "earn-program";
  }
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
  if (pathname === "/dashboard/settings") return "settings";
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
  if (href === "/dashboard") {
    // Holdings has no nav entry of its own and is only reached from the home
    // allocation card, so Home keeps the highlight rather than the sidebar going
    // blank while you are on it.
    return pathname === "/dashboard" || pathname === "/dashboard/tokens";
  }
  if (href === "/dashboard/integrations") {
    return (
      pathname === "/dashboard/integrations" || pathname.startsWith("/dashboard/integrations/")
    );
  }
  if (href === "/dashboard/wallets") {
    return pathname.startsWith("/dashboard/wallets") || pathname.startsWith("/dashboard/custody");
  }
  if (href === "/dashboard/payments") {
    return pathname === "/dashboard/payments" || pathname.startsWith("/dashboard/payments/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
