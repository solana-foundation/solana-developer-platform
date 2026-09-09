import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveQuickStartProgress } from "./quick-start-actions";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), fetch: vi.fn() }));
vi.mock("./sdp-api", () => ({
  getSdpAuth: mocks.auth,
  createOrgSdpApiClient: async () => ({ fetch: mocks.fetch }),
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ orgId: "clerk_org", orgRole: "org:admin" });
  mocks.fetch.mockResolvedValue({
    organization: { id: "sdp_org", settings: {} },
    setup: { status: "not_started" },
  });
});
describe("quick-start persistence", () => {
  it("saves optional guide completion without invoking legacy custody setup", async () => {
    expect(await saveQuickStartProgress("clerk_org", "done")).toBe(true);
    expect(mocks.fetch).toHaveBeenLastCalledWith("/v1/organizations/sdp_org", {
      method: "PATCH",
      body: JSON.stringify({ settings: { quickStartStep: "done" } }),
    });
  });
  it("cannot update another org after a workspace switch", async () => {
    expect(await saveQuickStartProgress("old_org", "done")).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not let members update organization setup", async () => {
    mocks.auth.mockResolvedValue({ orgId: "clerk_org", orgRole: "org:member" });
    expect(await saveQuickStartProgress("clerk_org", "done")).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not reopen server-completed onboarding from a stale tab", async () => {
    mocks.fetch.mockResolvedValue({
      organization: { id: "sdp_org", settings: { quickStartStep: "done" } },
    });
    expect(await saveQuickStartProgress("clerk_org", "wallet")).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not report a save when sync or the API is unavailable", async () => {
    mocks.fetch.mockResolvedValue({ organization: null });
    expect(await saveQuickStartProgress("clerk_org", "done")).toBe(false);
    mocks.fetch.mockRejectedValue(new Error("unavailable"));
    expect(await saveQuickStartProgress("clerk_org", "done")).toBe(false);
  });
});
