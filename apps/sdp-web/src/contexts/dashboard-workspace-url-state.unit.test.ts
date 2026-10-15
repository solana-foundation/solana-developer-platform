import { describe, expect, it } from "vitest";
import { shouldClearDashboardTabAfterPathnameChange } from "./dashboard-workspace-url-state";

describe("dashboard workspace tab URL state", () => {
  it("preserves the redesigned wallet Settings tab when a provider bookmark resolves to its SDP ID", () => {
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard/wallets/provider-wallet",
        pathname: "/dashboard/wallets/cwlt_1",
        tab: "settings",
        newDesign: true,
      })
    ).toBe(false);
  });

  it.each([
    { pathname: "/dashboard/wallets/cwlt_1", tab: "overview" },
    { pathname: "/dashboard/wallets/cwlt_1", tab: "activity" },
    { pathname: "/dashboard/custody/cwlt_1", tab: "overview" },
    { pathname: "/dashboard/custody/cwlt_1", tab: "activity" },
    { pathname: "/dashboard/custody/cwlt_1/", tab: "settings" },
  ])("preserves the redesigned $tab destination on $pathname", ({ pathname, tab }) => {
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard/wallets/provider-wallet",
        pathname,
        tab,
        newDesign: true,
      })
    ).toBe(false);
  });

  it.each(["overview", "activity", "settings"])(
    "clears the unsupported %s wallet tab in the legacy design",
    (tab) => {
      expect(
        shouldClearDashboardTabAfterPathnameChange({
          previousPathname: "/dashboard/wallets/provider-wallet",
          pathname: "/dashboard/wallets/cwlt_1",
          tab,
          newDesign: false,
        })
      ).toBe(true);
    }
  );

  it.each(["playground", "unknown", "Settings"])(
    "clears the unsupported %s tab on a redesigned wallet detail",
    (tab) => {
      expect(
        shouldClearDashboardTabAfterPathnameChange({
          previousPathname: "/dashboard/wallets/provider-wallet",
          pathname: "/dashboard/wallets/cwlt_1",
          tab,
          newDesign: true,
        })
      ).toBe(true);
    }
  );

  it.each([
    "/dashboard/wallets",
    "/dashboard/wallets/setup",
    "/dashboard/wallets/connections",
    "/dashboard/wallets/switch",
    "/dashboard/wallets/cwlt_1/policies",
    "/dashboard/custody/connections",
    "/dashboard/custody/cwlt_1/audit",
    "/dashboard/payments/cwlt_1",
  ])("clears a Settings tab on the non-wallet-detail route %s", (pathname) => {
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard/wallets/cwlt_1",
        pathname,
        tab: "settings",
        newDesign: true,
      })
    ).toBe(true);
  });

  it("preserves an explicit Payments playground destination", () => {
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard/payments/pay",
        pathname: "/dashboard/payments",
        tab: "playground",
      })
    ).toBe(false);
  });

  it("preserves the issuance playground destination", () => {
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard",
        pathname: "/dashboard/issuance",
        tab: "playground",
      })
    ).toBe(false);
  });

  // Contacts and Requests lost their playground tabs; their endpoints live in the Payments one.
  it.each([
    "/dashboard/payments/transactions",
    "/dashboard/payments/pay",
    "/dashboard/payments/counterparty",
    "/dashboard/payments/requests",
    "/dashboard/settings",
  ])("clears a leaked playground tab on %s", (pathname) => {
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard/payments",
        pathname,
        tab: "playground",
      })
    ).toBe(true);
  });

  it("retains the existing same-path behavior and clears unsupported tab values elsewhere", () => {
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard/payments/requests",
        pathname: "/dashboard/payments/requests/",
        tab: "playground",
      })
    ).toBe(false);
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard",
        pathname: "/dashboard/payments/requests",
        tab: "overview",
      })
    ).toBe(true);
  });

  it("keeps the playground tab when landing on the private channels overview", () => {
    // A cross-route jump from a sibling sub-page, and the legacy
    // /api-playground redirect, both arrive here carrying tab=playground.
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard/integrations/private-channels/members",
        pathname: "/dashboard/integrations/private-channels/overview",
        tab: "playground",
      })
    ).toBe(false);
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard/integrations/private-channels/api-playground",
        pathname: "/dashboard/integrations/private-channels/overview",
        tab: "playground",
      })
    ).toBe(false);
  });

  // The previous design still serves those two playgrounds as tabs on their own routes.
  it.each(["/dashboard/payments/counterparty", "/dashboard/payments/requests"])(
    "preserves the %s playground tab with NEW DESIGN off",
    (pathname) => {
      expect(
        shouldClearDashboardTabAfterPathnameChange({
          previousPathname: "/dashboard/payments",
          pathname,
          tab: "playground",
          newDesign: false,
        })
      ).toBe(false);
    }
  );

  it.each(["custody", "ramps", "compliance", "privacy"])(
    "keeps the %s tab an Integrations submenu link opens from another page",
    (tab) => {
      expect(
        shouldClearDashboardTabAfterPathnameChange({
          previousPathname: "/dashboard/payments",
          pathname: "/dashboard/integrations",
          tab,
        })
      ).toBe(false);
    }
  );

  it("clears tabs the Integrations hub does not own", () => {
    for (const tab of ["playground", "overview"]) {
      expect(
        shouldClearDashboardTabAfterPathnameChange({
          previousPathname: "/dashboard/payments",
          pathname: "/dashboard/integrations",
          tab,
        })
      ).toBe(true);
    }
  });
});
