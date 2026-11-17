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

  it("is ready on the production project of a mainnet-only deployment once mainnet is on", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ linked: true, organization: { id: "org_sdp" } })
      .mockResolvedValueOnce({ projects: [PRODUCTION_PROJECT] })
      .mockResolvedValueOnce({ state: "approved", mainnetOnly: true });
    expect(await resolveWorkspaceReadiness({ fetch })).toEqual({
      state: "ready",
      projectId: PRODUCTION_PROJECT.id,
    });
    expect(fetch.mock.calls[2]?.[0]).toBe("/v1/organizations/org_sdp/mainnet-access");
  });

  it("is locked on a mainnet-only deployment until SDP turns mainnet on", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ linked: true, organization: { id: "org_sdp" } })
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValueOnce({ state: "not_requested", mainnetOnly: true });
    expect(await resolveWorkspaceReadiness({ fetch })).toEqual({ state: "locked" });
  });

  it("keeps waiting for the sandbox where the deployment serves it", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ linked: true, organization: { id: "org_sdp" } })
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValueOnce({ state: "not_requested", mainnetOnly: false });
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
