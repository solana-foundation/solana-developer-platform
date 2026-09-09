import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadQuickStartStep } from "./quick-start-server";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./sdp-api", () => ({ createOrgSdpApiClient: async () => ({ fetch: mocks.fetch }) }));
beforeEach(() => vi.resetAllMocks());
describe("saved onboarding eligibility", () => {
  it("suppresses the guide for legacy completed organizations", async () => {
    mocks.fetch.mockResolvedValue({ linked: true, setup: { status: "complete", canManage: true } });
    expect(await loadQuickStartStep()).toBe("done");
  });
  it("uses saved quick-start completion in a fresh browser", async () => {
    mocks.fetch.mockResolvedValue({
      linked: true,
      setup: { status: "not_started", canManage: true },
      organization: { settings: { quickStartStep: "done" } },
    });
    expect(await loadQuickStartStep()).toBe("done");
  });
  it("starts only a synced, incomplete organization", async () => {
    mocks.fetch.mockResolvedValue({
      linked: true,
      setup: { status: "not_started", canManage: true },
      organization: { settings: {} },
    });
    expect(await loadQuickStartStep()).toBe("api-key");
    mocks.fetch.mockResolvedValue({ linked: false });
    expect(await loadQuickStartStep()).toBeNull();
  });
  it("does not mistake failures or a read-only membership for a new organization", async () => {
    mocks.fetch.mockRejectedValue(new Error("unavailable"));
    expect(await loadQuickStartStep()).toBeNull();
    mocks.fetch.mockResolvedValue({ linked: true, setup: { canManage: false } });
    expect(await loadQuickStartStep()).toBeNull();
  });
});
