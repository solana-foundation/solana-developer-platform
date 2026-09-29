import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadQuickStartStatus } from "./quick-start-server";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), projects: vi.fn() }));
vi.mock("./sdp-api", () => ({
  createOrgSdpApiClient: async () => ({ fetch: mocks.fetch }),
  listSdpProjects: mocks.projects,
}));

const onboarding = (setup: Record<string, unknown> | null, linked = true) => ({
  linked,
  setup:
    setup === null
      ? null
      : {
          status: "in_progress",
          canManage: true,
          rpcProvider: null,
          custodyProvider: null,
          ...setup,
        },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.projects.mockResolvedValue([{ id: "sandbox_project" }, { id: "production_project" }]);
});

describe("quick start status from organization state", () => {
  it("reads the providers and the latest call across every project", async () => {
    mocks.fetch
      .mockResolvedValueOnce(onboarding({ rpcProvider: "helius", custodyProvider: "privy" }))
      .mockResolvedValueOnce({
        apiKeys: [{ id: "a", lastUsedAt: "2026-09-24T10:00:00.000Z" }],
      })
      .mockResolvedValueOnce({
        apiKeys: [
          { id: "b", lastUsedAt: "2026-09-25T08:00:00.000Z" },
          { id: "c", lastUsedAt: null },
        ],
      });
    expect(await loadQuickStartStatus()).toEqual({
      rpcProvider: "helius",
      custodyProvider: "privy",
      apiKeyCount: 3,
      lastCallAt: "2026-09-25T08:00:00.000Z",
    });
    for (const projectId of ["sandbox_project", "production_project"]) {
      expect(mocks.fetch).toHaveBeenCalledWith("/v1/api-keys", {
        headers: { "x-project-id": projectId },
        signal: expect.any(AbortSignal),
      });
    }
  });

  it("reports no call while keys exist but none has signed a request", async () => {
    mocks.fetch
      .mockResolvedValueOnce(onboarding({}))
      .mockResolvedValueOnce({ apiKeys: [{ id: "a", lastUsedAt: null }] })
      .mockResolvedValueOnce({ apiKeys: [] });
    expect(await loadQuickStartStatus()).toMatchObject({ apiKeyCount: 1, lastCallAt: null });
  });

  it("hides the guide from viewers who cannot manage setup", async () => {
    mocks.fetch.mockResolvedValueOnce(onboarding({ canManage: false }));
    expect(await loadQuickStartStatus()).toBeNull();
    expect(mocks.projects).not.toHaveBeenCalled();
  });

  it("hides the guide for an organization that is not linked yet", async () => {
    mocks.fetch.mockResolvedValueOnce(onboarding(null, false));
    expect(await loadQuickStartStatus()).toBeNull();
  });

  it("does not mistake an unavailable key list for an organization with no keys", async () => {
    mocks.fetch
      .mockResolvedValueOnce(onboarding({}))
      .mockRejectedValueOnce(new Error("API-key service unavailable"))
      .mockResolvedValueOnce({ apiKeys: [] });
    expect(await loadQuickStartStatus()).toBeNull();
  });

  it("uses the keys it could read when another project's list fails", async () => {
    mocks.fetch
      .mockResolvedValueOnce(onboarding({}))
      .mockRejectedValueOnce(new Error("API-key service unavailable"))
      .mockResolvedValueOnce({ apiKeys: [{ id: "a", lastUsedAt: "2026-09-25T08:00:00.000Z" }] });
    expect(await loadQuickStartStatus()).toMatchObject({
      apiKeyCount: 1,
      lastCallAt: "2026-09-25T08:00:00.000Z",
    });
  });

  it("returns unknown rather than new when the status request fails", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("offline"));
    expect(await loadQuickStartStatus()).toBeNull();
  });
});
