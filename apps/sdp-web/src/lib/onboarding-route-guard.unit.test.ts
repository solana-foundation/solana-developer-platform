import { describe, expect, it } from "vitest";
import { shouldRedirectToOrganizationOnboarding } from "./onboarding-route-guard";

describe("shouldRedirectToOrganizationOnboarding", () => {
  it.each([
    "/dashboard",
    "/dashboard/wallets",
    "/dashboard/payments/transactions",
  ])("gates incomplete organizations from %s", (pathname) => {
    expect(shouldRedirectToOrganizationOnboarding("not_started", pathname)).toBe(true);
    expect(shouldRedirectToOrganizationOnboarding("in_progress", pathname)).toBe(true);
  });

  it("allows the onboarding route and completed organizations", () => {
    expect(shouldRedirectToOrganizationOnboarding("not_started", "/dashboard/onboarding")).toBe(
      false
    );
    expect(
      shouldRedirectToOrganizationOnboarding("in_progress", "/dashboard/onboarding/custody")
    ).toBe(false);
    expect(shouldRedirectToOrganizationOnboarding("complete", "/dashboard/wallets")).toBe(false);
    expect(shouldRedirectToOrganizationOnboarding(null, "/dashboard/wallets")).toBe(false);
  });
});
