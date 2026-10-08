import { describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { resolveWorkspaceReadiness } from "./workspace-readiness";

describe("workspace readiness", () => {
  it("waits for Clerk sync before requesting any project data", async () => {
    const fetch = vi.fn().mockResolvedValue({ linked: false });
    expect(await resolveWorkspaceReadiness({ fetch })).toEqual({
      state: "pending",
      reason: "sync",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is ready on the sandbox project once the default projects exist", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ linked: true })
      .mockResolvedValueOnce({ projects: [PRODUCTION_PROJECT, SANDBOX_PROJECT] });
    expect(await resolveWorkspaceReadiness({ fetch })).toEqual({
      state: "ready",
      projectId: SANDBOX_PROJECT.id,
    });
  });

  it("waits for default project provisioning", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ linked: true })
      .mockResolvedValueOnce({ projects: [] });
    expect(await resolveWorkspaceReadiness({ fetch })).toEqual({
      state: "pending",
      reason: "sync",
    });
  });

  it.each([
    [403, "access"],
    [503, "service"],
  ])("keeps failure %s distinct from an empty workspace", async (status, reason) => {
    const fetch = vi.fn().mockResolvedValueOnce({ linked: true }).mockRejectedValueOnce({ status });
    expect(await resolveWorkspaceReadiness({ fetch })).toEqual({ state: "pending", reason });
  });
});
