import { describe, expect, it } from "vitest";
import { shouldClearDashboardTabAfterPathnameChange } from "./dashboard-workspace-url-state";

describe("dashboard workspace tab URL state", () => {
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
    "/dashboard/integrations/private-channels/overview",
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

  it.each(["custody", "rpc", "ramps", "compliance", "private_channels"])(
    "keeps the %s family tab a link to Integrations opens from another page",
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

  it.each([
    ["/dashboard/payments", "members", false],
    ["/dashboard/payments", "security", false],
    ["/dashboard/payments", "playground", true],
  ])("from %s, Settings clears the %s tab: %s", (previousPathname, tab, cleared) => {
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname,
        pathname: "/dashboard/settings",
        tab,
      })
    ).toBe(cleared);
  });

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
