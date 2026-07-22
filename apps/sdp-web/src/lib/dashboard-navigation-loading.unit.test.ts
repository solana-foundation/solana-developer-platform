import { describe, expect, it } from "vitest";
import {
  resolveDashboardLoadingRoute,
  resolveDashboardNavigationIntent,
  resolveDashboardNavigationTarget,
} from "./dashboard-navigation-loading";

const CURRENT_DASHBOARD_URL = "http://localhost:3100/dashboard";

describe("dashboard loading route", () => {
  it.each([
    ["/dashboard", "home"],
    ["/dashboard/wallets", "wallets-overview"],
    ["/dashboard/wallets/setup", "wallet-setup"],
    ["/dashboard/wallets/wallet-1", "wallet-detail"],
    ["/dashboard/wallets/wallet-1/policy", "wallet-policy"],
    ["/dashboard/wallets/wallet-1/policy/audit", "wallet-policy-audit-list"],
    ["/dashboard/wallets/wallet-1/policy/audit/evaluation-1", "wallet-policy-audit-detail"],
    ["/dashboard/wallets/wallet-1/policy/revisions", "wallet-policy-revisions"],
    ["/dashboard/custody", "wallets-overview"],
    ["/dashboard/custody/switch", "wallet-setup"],
    ["/dashboard/custody/wallet-1", "wallet-detail"],
    ["/dashboard/issuance", "issuance-overview"],
    ["/dashboard/issuance/create", "issuance-create"],
    ["/dashboard/issuance/token-1", "issuance-detail"],
    ["/dashboard/payments", "payments-overview"],
    ["/dashboard/payments/transactions", "payments-transactions"],
    ["/dashboard/payments/pay", "payments-pay"],
    ["/dashboard/payments/deposit", "payments-deposit"],
    ["/dashboard/payments/requests", "payment-requests"],
    ["/dashboard/payments/counterparty", "counterparty-directory"],
    ["/dashboard/payments/counterparty/create", "counterparty-create"],
    ["/dashboard/payments/counterparty/counterparty-1", "counterparty-detail"],
    ["/dashboard/payments/recurring", "recurring-payments"],
    ["/dashboard/payments/recurring/create", "recurring-payment-create"],
    ["/dashboard/payments/recurring/payment-1", "recurring-payment-detail"],
    ["/dashboard/markets/earn", "earn-overview"],
    ["/dashboard/markets/earn/deposit", "earn-deposit"],
    ["/dashboard/markets/earn/strategies/strategy-1", "earn-strategy-detail"],
    ["/dashboard/api-keys", "api-keys-list"],
    ["/dashboard/api-keys/new", "api-key-new"],
    ["/dashboard/api-keys/key-1/edit", "api-key-edit"],
    ["/dashboard/policies", "policies"],
    ["/dashboard/approvals", "approvals-list"],
    ["/dashboard/approvals/request-1", "approval-detail"],
    ["/dashboard/members", "members"],
    ["/dashboard/settings", "settings"],
    ["/dashboard/allowlist", "allowlist"],
  ])("maps %s to its exact route skeleton", (pathname, route) => {
    expect(resolveDashboardLoadingRoute(pathname)).toBe(route);
  });

  it.each([
    "/dashboard/wallets/wallet-1/policy/unknown",
    "/dashboard/api-keys/key-1",
    "/dashboard/unknown",
    "/dashboard/walletsmith",
    "/sign-in",
  ])("does not invent a fallback for unsupported route %s", (pathname) => {
    expect(resolveDashboardLoadingRoute(pathname)).toBeNull();
  });
});

describe("dashboard navigation intent", () => {
  it("starts immediate loading feedback for a different dashboard route", () => {
    expect(
      resolveDashboardNavigationIntent({
        currentHref: CURRENT_DASHBOARD_URL,
        targetHref: "/dashboard/wallets",
      })
    ).toBe("/dashboard/wallets");
  });

  it("keeps the target query with cross-route loading intent", () => {
    expect(
      resolveDashboardNavigationTarget({
        currentHref: `${CURRENT_DASHBOARD_URL}/payments?tab=playground`,
        targetHref: "/dashboard/payments/requests",
      })
    ).toEqual({ pathname: "/dashboard/payments/requests", search: "" });
    expect(
      resolveDashboardNavigationTarget({
        currentHref: CURRENT_DASHBOARD_URL,
        targetHref: "/dashboard/payments/requests?tab=playground",
      })
    ).toEqual({
      pathname: "/dashboard/payments/requests",
      search: "?tab=playground",
    });
  });

  it.each([
    ["same route query", { targetHref: "/dashboard?tab=playground" }],
    ["external route", { targetHref: "https://platform.solana.com/docs" }],
    ["new tab", { targetHref: "/dashboard/wallets", target: "_blank" }],
    ["download", { targetHref: "/dashboard/wallets", download: true }],
    ["modified click", { targetHref: "/dashboard/wallets", metaKey: true }],
    ["unsupported dashboard route", { targetHref: "/dashboard/unknown" }],
    ["non-dashboard route", { targetHref: "/sign-in" }],
  ])("ignores %s navigation", (_label, input) => {
    expect(
      resolveDashboardNavigationIntent({
        currentHref: CURRENT_DASHBOARD_URL,
        ...input,
      })
    ).toBeNull();
  });
});
