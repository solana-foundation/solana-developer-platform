import { describe, expect, it } from "vitest";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { resolveProjectFromList } from "./dashboard-project-selection";

const sandbox = SANDBOX_PROJECT;
const production = PRODUCTION_PROJECT;

describe("resolveProjectFromList", () => {
  it("keeps the last-used project while the organization still lists it", () => {
    expect(resolveProjectFromList([sandbox, production], production.id)).toBe(production);
  });

  it("lands on the sandbox when the last-used project is no longer listed", () => {
    expect(resolveProjectFromList([production, sandbox], "prj_test_stale")).toBe(sandbox);
  });

  it("lands on the sandbox when there is no last-used project", () => {
    expect(resolveProjectFromList([production, sandbox], null)).toBe(sandbox);
    expect(resolveProjectFromList([production, sandbox], undefined)).toBe(sandbox);
  });

  it("never selects production when the organization has no sandbox", () => {
    expect(resolveProjectFromList([production], "prj_test_stale")).toBeNull();
    expect(resolveProjectFromList([production], null)).toBeNull();
  });

  it("returns null for an empty project list", () => {
    expect(resolveProjectFromList([], "prj_test_stale")).toBeNull();
  });
});
