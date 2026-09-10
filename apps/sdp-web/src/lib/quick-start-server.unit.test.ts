import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadQuickStartStep } from "./quick-start-server";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), projects: vi.fn() }));
vi.mock("./sdp-api", () => ({
  createOrgSdpApiClient: async () => ({ fetch: mocks.fetch }),
  listSdpProjects: mocks.projects,
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.projects.mockResolvedValue([{ id: "sandbox_project" }, { id: "production_project" }]);
  mocks.fetch.mockResolvedValue({ wallets: [] }).mockResolvedValueOnce({
    linked: true,
    setup: { status: "not_started", canManage: true, custodyProvider: null },
  });
});
describe("onboarding eligibility from organization state", () => {
  it("suppresses the guide for legacy completed organizations", async () => {
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue({ linked: true, setup: { status: "complete", canManage: true } });
    expect(await loadQuickStartStep()).toBe("done");
    expect(mocks.projects).not.toHaveBeenCalled();
  });
  it("suppresses the guide for an existing default wallet without requiring legacy completion", async () => {
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue({
      linked: true,
      setup: { status: "in_progress", canManage: true, custodyProvider: "local" },
    });
    expect(await loadQuickStartStep()).toBe("done");
    expect(mocks.projects).not.toHaveBeenCalled();
  });
  it("starts a synced, incomplete organization only when all accessible projects have no wallets", async () => {
    expect(await loadQuickStartStep()).toBe("api-key");
    for (const projectId of ["sandbox_project", "production_project"]) {
      expect(mocks.fetch).toHaveBeenCalledWith(
        "/v1/wallets?includeAllProviders=true&includeBalances=false&view=summary",
        { headers: { "x-project-id": projectId }, signal: expect.any(AbortSignal) }
      );
    }
  });
  it("suppresses the guide when a wallet exists outside the default sandbox", async () => {
    mocks.fetch.mockResolvedValueOnce({ wallets: [] }).mockResolvedValueOnce({
      wallets: [{ id: "existing_production_wallet" }],
    });
    expect(await loadQuickStartStep()).toBe("done");
  });
  it("does not mistake an unavailable wallet list for a new organization", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("wallet service unavailable"));
    expect(await loadQuickStartStep()).toBeNull();
  });
  it("still suppresses the guide when a known wallet exists and another project fails", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("wallet service unavailable"));
    mocks.fetch.mockResolvedValueOnce({ wallets: [{ id: "existing_wallet" }] });
    expect(await loadQuickStartStep()).toBe("done");
  });
  it("does not start while organization or project provisioning is incomplete", async () => {
    mocks.projects.mockResolvedValue([]);
    expect(await loadQuickStartStep()).toBeNull();
    mocks.fetch.mockResolvedValue({ linked: false });
    expect(await loadQuickStartStep()).toBeNull();
  });
  it("does not mistake failures or a read-only membership for a new organization", async () => {
    mocks.fetch.mockReset();
    mocks.fetch.mockRejectedValue(new Error("unavailable"));
    expect(await loadQuickStartStep()).toBeNull();
    mocks.fetch.mockResolvedValue({ linked: true, setup: { canManage: false } });
    expect(await loadQuickStartStep()).toBeNull();
    expect(mocks.projects).not.toHaveBeenCalled();
  });
});
