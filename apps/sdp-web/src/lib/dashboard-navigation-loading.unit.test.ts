import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_PAYMENTS_SUBNAV_HREFS,
  DASHBOARD_SIDE_NAV_HREFS,
  resolveDashboardLoadingSurface,
  resolveDashboardNavigationIntent,
} from "./dashboard-navigation-loading";

const CURRENT_DASHBOARD_URL = "http://localhost:3100/dashboard";
const TEST_SEGMENT_VALUE = "loading-contract-sample";

function dashboardPagesDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app/dashboard");
}

function routePathnameForPage(pagePath: string): string {
  const relativeDirectory = path.relative(dashboardPagesDirectory(), path.dirname(pagePath));
  const segments = relativeDirectory
    .split(path.sep)
    .filter((segment) => segment && !segment.startsWith("("))
    .map((segment) => (segment.startsWith("[") ? TEST_SEGMENT_VALUE : segment));

  return ["", "dashboard", ...segments].join("/");
}

function findDashboardPages(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findDashboardPages(entryPath);
    return entry.name === "page.tsx" ? [entryPath] : [];
  });
}

describe("dashboard loading route inventory", () => {
  it("gives every dashboard page route an immediate loading contract", () => {
    const pageRoutes = findDashboardPages(dashboardPagesDirectory()).map(routePathnameForPage);

    expect(pageRoutes.length).toBeGreaterThan(0);
    for (const route of pageRoutes) {
      expect(resolveDashboardLoadingSurface(route), route).not.toBeNull();
    }
  });

  it("covers every visible side-nav and Payments subnav destination", () => {
    const visibleTargets = [
      ...Object.values(DASHBOARD_SIDE_NAV_HREFS),
      ...Object.values(DASHBOARD_PAYMENTS_SUBNAV_HREFS),
    ];

    for (const target of visibleTargets) {
      expect(resolveDashboardLoadingSurface(target), target).not.toBeNull();
    }
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

  it.each([
    ["same route query", { targetHref: "/dashboard?tab=playground" }],
    ["external route", { targetHref: "https://platform.solana.com/docs" }],
    ["new tab", { targetHref: "/dashboard/wallets", target: "_blank" }],
    ["download", { targetHref: "/dashboard/wallets", download: true }],
    ["modified click", { targetHref: "/dashboard/wallets", metaKey: true }],
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
