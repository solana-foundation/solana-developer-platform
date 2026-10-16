import { describe, expect, it } from "vitest";
import { parseDashboardPathname, projectHref } from "./dashboard-project-path";

describe("parseDashboardPathname", () => {
  it.each([
    [
      "/dashboard/prj_test_sandbox/payments/transfers",
      "prj_test_sandbox",
      "/dashboard/payments/transfers",
    ],
    ["/dashboard/prj_test_sandbox", "prj_test_sandbox", "/dashboard"],
    ["/dashboard/payments/transfers", null, "/dashboard/payments/transfers"],
    ["/dashboard", null, "/dashboard"],
    ["/dashboard//evil.com", null, "/dashboard//evil.com"],
    ["/dashboarding/prj_test_sandbox", null, "/dashboarding/prj_test_sandbox"],
    ["/sign-in", null, "/sign-in"],
  ])("splits %s into its project and project-less path", (pathname, projectId, dashboardPath) => {
    expect(parseDashboardPathname(pathname)).toEqual({ projectId, dashboardPath });
  });
});

describe("projectHref", () => {
  it.each([
    ["/dashboard/api-keys/new", "/dashboard/prj_test_sandbox/api-keys/new"],
    ["/dashboard", "/dashboard/prj_test_sandbox"],
    ["/dashboard?tab=activity", "/dashboard/prj_test_sandbox?tab=activity"],
    ["/dashboard#activity", "/dashboard/prj_test_sandbox#activity"],
    [
      "/dashboard/policies?tab=audit#latest",
      "/dashboard/prj_test_sandbox/policies?tab=audit#latest",
    ],
  ])("scopes %s to the project", (dashboardPath, href) => {
    expect(projectHref("prj_test_sandbox", dashboardPath)).toBe(href);
  });

  it.each(["/settings", "/dashboarding", "https://evil.example/dashboard"])(
    "rejects %s, which is outside the dashboard",
    (path) => {
      expect(() => projectHref("prj_test_sandbox", path)).toThrow(`Not a dashboard path: ${path}`);
    }
  );
});
