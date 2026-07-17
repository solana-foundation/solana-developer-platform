import type { Project } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { resolveDashboardProjectSelection } from "./dashboard-project-selection";

const sandbox = { id: "prj_sandbox", slug: "default-sandbox" } as Project;
const production = { id: "prj_production", slug: "default-production" } as Project;

describe("resolveDashboardProjectSelection", () => {
  it("keeps a valid cookie selection", () => {
    expect(resolveDashboardProjectSelection([sandbox, production], production.id)).toEqual({
      selectedProjectId: production.id,
      shouldRepairCookie: false,
    });
  });

  it("uses the sandbox without scheduling a write when the cookie is missing", () => {
    expect(resolveDashboardProjectSelection([sandbox, production], null)).toEqual({
      selectedProjectId: sandbox.id,
      shouldRepairCookie: false,
    });
  });

  it("uses the sandbox and schedules repair when the cookie is stale", () => {
    expect(resolveDashboardProjectSelection([production, sandbox], "prj_old_org")).toEqual({
      selectedProjectId: sandbox.id,
      shouldRepairCookie: true,
    });
  });

  it("does not silently select production when an organization has no sandbox", () => {
    expect(resolveDashboardProjectSelection([production], null)).toEqual({
      selectedProjectId: null,
      shouldRepairCookie: false,
    });
  });
});
