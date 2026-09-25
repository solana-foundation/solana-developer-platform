import { describe, expect, it } from "vitest";
import { themeScopeForPath } from "./theme-scope-routes";

describe("themeScopeForPath", () => {
  it.each([
    "/dashboard/payments",
    "/dashboard/payments/pay",
    "/dashboard/payments/counterparty/cp_1",
    "/dashboard/integrations/private-channels/setup",
    "/dashboard/integrations/private-channels/inst_1/setup",
  ])("puts %s in the refresh scope", (pathname) => {
    expect(themeScopeForPath(pathname)).toBe("refresh");
  });

  it.each([
    "/dashboard",
    "/dashboard/payments-archive",
    "/dashboard/issuance",
    "/dashboard/integrations/private-channels/overview",
    "/dashboard/integrations/private-channels/inst_1/channels",
    "/dashboard/integrations/private-channels/inst_1/setup/extra",
  ])("keeps %s in the base design", (pathname) => {
    expect(themeScopeForPath(pathname)).toBeNull();
  });
});
