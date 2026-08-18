import { describe, expect, it } from "vitest";
import {
  isDashboardNavItemActive,
  resolveDashboardLoadingRoute,
} from "./dashboard-navigation-loading";

describe("dashboard loading route", () => {
  it.each([
    ["/dashboard", "home"],
    ["/dashboard/wallets", "wallets-overview"],
    ["/dashboard/wallets/setup", "wallet-setup"],
    ["/dashboard/wallets/wallet-1", "wallet-detail"],
    ["/dashboard/wallets/wallet-1/policy", "wallet-policy"],
    ["/dashboard/wallets/wallet-1/policy/audit", "wallet-policy-audit-list"],
    ["/dashboard/wallets/wallet-1/policy/audit/evaluation-1", "wallet-policy-audit-detail"],
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
    ["/dashboard/tokens", "token-holdings"],
    ["/dashboard/api-keys", "api-keys-list"],
    ["/dashboard/api-keys/new", "api-key-new"],
    ["/dashboard/api-keys/key-1/edit", "api-key-edit"],
    ["/dashboard/policies", "policies"],
    ["/dashboard/approvals", "approvals-list"],
    ["/dashboard/approvals/request-1", "approval-detail"],
    ["/dashboard/settings", "settings"],
    ["/dashboard/integrations", "integrations"],
    ["/dashboard/integrations/privy", "integration-detail"],
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

describe("integrations route", () => {
  it("keeps the Integrations nav item lit across its subtree", () => {
    expect(isDashboardNavItemActive("/dashboard/integrations", "/dashboard/integrations")).toBe(
      true
    );
    expect(
      isDashboardNavItemActive("/dashboard/integrations/privy", "/dashboard/integrations")
    ).toBe(true);
    expect(isDashboardNavItemActive("/dashboard/wallets", "/dashboard/integrations")).toBe(false);
  });
});

describe("dashboard navigation active state", () => {
  it.each([
    "/dashboard/markets/earn",
    "/dashboard/markets/earn/deposit",
    "/dashboard/markets/earn/strategies/strategy-1",
  ])("keeps Markets active throughout the Earn flow at %s", (pathname) => {
    expect(isDashboardNavItemActive(pathname, "/dashboard/markets/earn")).toBe(true);
  });

  it("does not claim unrelated dashboard routes for Markets", () => {
    expect(isDashboardNavItemActive("/dashboard/payments", "/dashboard/markets/earn")).toBe(false);
  });
});

describe("holdings route", () => {
  it("resolves its own loading route rather than falling back to home", () => {
    expect(resolveDashboardLoadingRoute("/dashboard/tokens")).toBe("token-holdings");
  });

  it("keeps Home highlighted so the sidebar does not go blank", () => {
    expect(isDashboardNavItemActive("/dashboard/tokens", "/dashboard")).toBe(true);
  });

  it("does not light up an unrelated nav item", () => {
    expect(isDashboardNavItemActive("/dashboard/tokens", "/dashboard/wallets")).toBe(false);
    expect(isDashboardNavItemActive("/dashboard/tokens", "/dashboard/payments")).toBe(false);
  });
});
