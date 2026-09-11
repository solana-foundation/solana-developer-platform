import { describe, expect, it, vi } from "vitest";
import { resolveWorkspaceReadiness } from "./workspace-readiness";

describe("workspace readiness", () => {
  it("waits for Clerk sync before requesting any project data", async () => {
    const fetch = vi.fn().mockResolvedValue({ linked: false });
    expect(await resolveWorkspaceReadiness({ fetch }, "old-project")).toEqual({
      state: "pending",
      reason: "sync",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("replaces a stale org project before rendering the dashboard", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ linked: true })
      .mockResolvedValueOnce({ projects: [{ id: "new-project", slug: "default-sandbox" }] });
    expect(await resolveWorkspaceReadiness({ fetch }, "old-project")).toEqual({
      state: "ready",
      projectId: "new-project",
    });
  });
  it("preserves a valid project selection", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ linked: true })
      .mockResolvedValueOnce({
        projects: [
          { id: "sandbox", slug: "default-sandbox" },
          { id: "production", slug: "default-production" },
        ],
      });
    expect(await resolveWorkspaceReadiness({ fetch }, "production")).toEqual({
      state: "ready",
      projectId: "production",
    });
  });
  it("waits for default project provisioning", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ linked: true })
      .mockResolvedValueOnce({ projects: [] });
    expect(await resolveWorkspaceReadiness({ fetch }, null)).toEqual({
      state: "pending",
      reason: "sync",
    });
  });
  it.each([
    [403, "access"],
    [503, "service"],
  ])("keeps failure %s distinct from an empty workspace", async (status, reason) => {
    const fetch = vi.fn().mockResolvedValueOnce({ linked: true }).mockRejectedValueOnce({ status });
    expect(await resolveWorkspaceReadiness({ fetch }, null)).toEqual({ state: "pending", reason });
  });
});
