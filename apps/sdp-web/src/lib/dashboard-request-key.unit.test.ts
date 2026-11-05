import { describe, expect, it } from "vitest";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import {
  type DashboardKeyScope,
  dashboardRequestKey,
  dashboardRequestUrl,
  isDashboardRequestKey,
  readsUnderPath,
} from "./dashboard-request-key";

const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "live" };

describe("dashboardRequestUrl", () => {
  it("sorts the params and drops the undefined ones", () => {
    const key = dashboardRequestKey(SCOPE, "/api/dashboard/counterparty", {
      pageSize: 20,
      includeBalances: undefined,
      page: 2,
      active: true,
    });
    expect(dashboardRequestUrl(key)).toBe(
      "/api/dashboard/counterparty?active=true&page=2&pageSize=20"
    );
  });

  it.each([
    ["no params", dashboardRequestKey(SCOPE, "/api/dashboard/wallets")],
    [
      "only undefined params",
      dashboardRequestKey(SCOPE, "/api/dashboard/wallets", { view: undefined }),
    ],
  ])("is the bare path for a key with %s", (_case, key) => {
    expect(dashboardRequestUrl(key)).toBe("/api/dashboard/wallets");
  });
});

describe("isDashboardRequestKey", () => {
  it.each([
    [[SANDBOX_PROJECT.id, "live", "/api/dashboard/wallets"], true],
    [[SANDBOX_PROJECT.id, "demo", "/api/dashboard/wallets", { view: "summary" }], true],
    ["wallet-card-balances", false],
    [["wallet-activity", "wal_test_1"], false],
    [[SANDBOX_PROJECT.id, "sandbox", "/api/dashboard/wallets"], false],
    [[SANDBOX_PROJECT.id, "live", "/dashboard/wallets"], false],
    [[1, "live", "/api/dashboard/wallets"], false],
    [[SANDBOX_PROJECT.id, "live", "/api/dashboard/wallets", {}, "extra"], false],
  ])("reads %j as a request key: %s", (key, expected) => {
    expect(isDashboardRequestKey(key)).toBe(expected);
  });
});

describe("readsUnderPath", () => {
  it.each([
    ["/api/dashboard/wallets", true],
    ["/api/dashboard/wallets/wal_test_1/balances", true],
    ["/api/dashboard/wallets-archive", false],
    ["/api/dashboard", false],
  ] as const)("matches %s under /api/dashboard/wallets: %s", (path, expected) => {
    const key = dashboardRequestKey({ projectId: PRODUCTION_PROJECT.id, mode: "demo" }, path);
    expect(readsUnderPath("/api/dashboard/wallets")(key)).toBe(expected);
  });
});
