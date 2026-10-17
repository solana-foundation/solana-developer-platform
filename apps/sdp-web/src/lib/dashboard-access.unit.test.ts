import { describe, expect, it } from "vitest";
import { dashboardRoleMayPerform, resolveDashboardAccess } from "./dashboard-access";

describe("resolveDashboardAccess", () => {
  // The project layout passes it to a client provider: React refuses a
  // function there, and the whole project view fails to render.
  it.each(["org:admin", "org:member", null])("is plain data for %s", (role) => {
    const access = resolveDashboardAccess(role);
    expect(structuredClone(access)).toEqual(access);
  });

  it("gives an admin key management and a member none", () => {
    expect(resolveDashboardAccess("org:admin").capabilities.canManageApiKeys).toBe(true);
    expect(resolveDashboardAccess("org:member").capabilities.canManageApiKeys).toBe(false);
  });
});

describe("dashboardRoleMayPerform", () => {
  it("decides an action from the organization role", () => {
    expect(dashboardRoleMayPerform("org:admin", "organizations.manage")).toBe(true);
    expect(dashboardRoleMayPerform("org:member", "organizations.manage")).toBe(false);
  });
});
