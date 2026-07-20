import { describe, expect, it } from "vitest";
import { shouldClearDashboardTabAfterPathnameChange } from "./dashboard-workspace-url-state";

describe("dashboard workspace tab URL state", () => {
  it.each([
    "/dashboard/payments",
    "/dashboard/payments/counterparty",
    "/dashboard/payments/requests",
  ])("preserves an explicit Payments playground destination at %s", (pathname) => {
    expect(
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname: "/dashboard/payments/pay",
        pathname,
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

  it.each([
    "/dashboard/payments/transactions",
    "/dashboard/payments/pay",
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
});
