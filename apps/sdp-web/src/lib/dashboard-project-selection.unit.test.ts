import type { Project } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  resolveDashboardProjectSelection,
  resolveProjectFromList,
} from "./dashboard-project-selection";

const sandbox = { id: "prj_sandbox", slug: "default-sandbox" } as Project;
const production = { id: "prj_production", slug: "default-production" } as Project;

describe("resolveProjectFromList", () => {
  it("keeps the cookie's project while the organization still lists it", () => {
    expect(resolveProjectFromList([sandbox, production], production.id)).toBe(production);
  });

  it("falls back to the sandbox when the cookie names a project outside the list", () => {
    expect(resolveProjectFromList([production, sandbox], "prj_old_org")).toBe(sandbox);
  });

  it("falls back to the sandbox when there is no cookie", () => {
    expect(resolveProjectFromList([production, sandbox], null)).toBe(sandbox);
    expect(resolveProjectFromList([production, sandbox], undefined)).toBe(sandbox);
  });

  it("stops at the sandbox by default so a missing one never selects production", () => {
    expect(resolveProjectFromList([production], "prj_old_org")).toBeNull();
    expect(resolveProjectFromList([production], null)).toBeNull();
  });

  it("takes the first project only when the caller opts in", () => {
    expect(
      resolveProjectFromList([production], "prj_old_org", { fallbackToFirstProject: true })
    ).toBe(production);
  });

  it("still prefers the cookie and the sandbox over the first project when opted in", () => {
    expect(
      resolveProjectFromList([production, sandbox], production.id, {
        fallbackToFirstProject: true,
      })
    ).toBe(production);
    expect(
      resolveProjectFromList([production, sandbox], "prj_old_org", {
        fallbackToFirstProject: true,
      })
    ).toBe(sandbox);
  });

  it("returns null for an empty list whatever the options", () => {
    expect(resolveProjectFromList([], "prj_old_org")).toBeNull();
    expect(resolveProjectFromList([], "prj_old_org", { fallbackToFirstProject: true })).toBeNull();
  });
});

describe("resolveDashboardProjectSelection", () => {
  it("keeps a valid cookie selection", () => {
    expect(
      resolveDashboardProjectSelection([sandbox, production], production.id, {
        projectListIsAuthoritative: true,
      })
    ).toEqual({ selectedProjectId: production.id, shouldRepairCookie: false });
  });

  it("uses the sandbox without scheduling a write when the cookie is missing", () => {
    expect(
      resolveDashboardProjectSelection([sandbox, production], null, {
        projectListIsAuthoritative: true,
      })
    ).toEqual({ selectedProjectId: sandbox.id, shouldRepairCookie: false });
  });

  it("uses the sandbox and schedules repair when the cookie is stale", () => {
    expect(
      resolveDashboardProjectSelection([production, sandbox], "prj_old_org", {
        projectListIsAuthoritative: true,
      })
    ).toEqual({ selectedProjectId: sandbox.id, shouldRepairCookie: true });
  });

  it("schedules repair for a stale cookie even when nothing else resolves", () => {
    expect(
      resolveDashboardProjectSelection([production], "prj_old_org", {
        projectListIsAuthoritative: true,
      })
    ).toEqual({ selectedProjectId: null, shouldRepairCookie: true });
  });

  it("does not silently select production when an organization has no sandbox", () => {
    expect(
      resolveDashboardProjectSelection([production], null, {
        projectListIsAuthoritative: true,
      })
    ).toEqual({ selectedProjectId: null, shouldRepairCookie: false });
  });

  it("does not repair a valid cookie when the project list failed to load", () => {
    expect(
      resolveDashboardProjectSelection([], production.id, {
        projectListIsAuthoritative: false,
      })
    ).toEqual({ selectedProjectId: null, shouldRepairCookie: false });
  });
});
