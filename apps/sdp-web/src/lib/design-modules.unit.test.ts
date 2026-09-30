import { describe, expect, it } from "vitest";
import { designModuleForPath, isNewDesignPage } from "./design-modules";

describe("designModuleForPath", () => {
  it.each([
    ["/dashboard/payments/counterparty", "contacts"],
    ["/dashboard/payments/counterparty/create", "contacts"],
    ["/dashboard/payments/counterparty/cp_1", "contacts"],
    ["/dashboard/payments/pay", "payDeposit"],
    ["/dashboard/payments/deposit", "payDeposit"],
    ["/dashboard/payments", "activity"],
    ["/dashboard/payments/transactions", "activity"],
    ["/dashboard/payments/requests/new", "activity"],
    ["/dashboard/payments/recurring/rp_1", "activity"],
    ["/dashboard/payments-archive", null],
    ["/dashboard", "overview"],
    ["/dashboard/tokens", null],
    ["/dashboard/wallets", "wallets"],
    ["/dashboard/custody/wal_1", "wallets"],
    ["/dashboard/wallets/setup", "wallets"],
    ["/dashboard/wallets/connections", null],
    ["/dashboard/wallets/wal_1/policy", null],
    ["/dashboard/issuance", null],
  ])("puts %s in %s", (pathname, designModule) => {
    expect(designModuleForPath(pathname)).toBe(designModule);
  });
});

describe("isNewDesignPage", () => {
  it.each([
    "/dashboard/tokens",
    "/dashboard/issuance",
    "/dashboard/integrations/private-channels/setup",
  ])("puts %s on NEW DESIGN alone", (pathname) => {
    expect(isNewDesignPage(pathname, { newDesign: true })).toBe(true);
    expect(isNewDesignPage(pathname, { newDesign: false })).toBe(false);
  });

  it("puts a module's page on its own flag, under NEW DESIGN", () => {
    const contacts = "/dashboard/payments/counterparty";
    expect(
      isNewDesignPage(contacts, { newDesign: true, newDesignModules: { contacts: true } })
    ).toBe(true);
    expect(
      isNewDesignPage(contacts, { newDesign: true, newDesignModules: { contacts: false } })
    ).toBe(false);
    expect(
      isNewDesignPage(contacts, { newDesign: false, newDesignModules: { contacts: true } })
    ).toBe(false);
  });

  it("lets a module with no flag of its own (older fixtures) follow NEW DESIGN", () => {
    expect(isNewDesignPage("/dashboard/payments/counterparty", { newDesign: true })).toBe(true);
  });

  it("keeps every page on the previous design outside the dashboard workspace", () => {
    expect(isNewDesignPage("/dashboard", undefined)).toBe(false);
    expect(isNewDesignPage("/dashboard/issuance", undefined)).toBe(false);
  });
});
