import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadQuickStartStatus } from "./quick-start-server";
import * as sdpApi from "./sdp-api";

vi.mock("next/headers", () => import("@/test/next-headers"));

const mocks = { fetch: vi.fn(), projectFetch: vi.fn(), projects: vi.fn() };

const onboarding = (setup: Record<string, unknown> | null, linked = true) => ({
  linked,
  setup:
    setup === null
      ? null
      : {
          status: "in_progress",
          canManage: true,
          custodyProviders: [],
          ...setup,
        },
});

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.fetch.mockReset();
  mocks.projectFetch.mockReset();
  mocks.projects.mockReset();
  vi.spyOn(sdpApi, "createOrgSdpApiClient").mockResolvedValue({
    request: vi.fn(),
    fetch: mocks.fetch,
  });
  // The open project's client: its wallet list is the wallet step's one read.
  vi.spyOn(sdpApi, "createSdpApiClient").mockResolvedValue({
    request: vi.fn(),
    fetch: mocks.projectFetch,
  });
  mocks.projectFetch.mockResolvedValue({ wallets: [] });
  vi.spyOn(sdpApi, "listSdpProjects").mockImplementation(mocks.projects);
  // The request's shared onboarding read rides the same fetch mock, so each case
  // below keeps its order: onboarding first, then each project's keys.
  vi.spyOn(sdpApi, "requestOnboardingStatus").mockImplementation(() =>
    mocks.fetch("/v1/onboarding/status")
  );
  mocks.projects.mockResolvedValue([{ id: "sandbox_project" }, { id: "production_project" }]);
});

describe("quick start status from organization state", () => {
  it("reads the open project's wallets and the latest call across every project", async () => {
    mocks.projectFetch.mockResolvedValueOnce({ wallets: [{ walletId: "privy_wallet_1" }] });
    mocks.fetch
      .mockResolvedValueOnce(onboarding({}))
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
      hasWallet: true,
      apiKeyCount: 3,
      lastCallAt: "2026-09-25T08:00:00.000Z",
    });
    for (const projectId of ["sandbox_project", "production_project"]) {
      expect(mocks.fetch).toHaveBeenCalledWith("/v1/api-keys", {
        headers: { "x-project-id": projectId },
        signal: expect.any(AbortSignal),
      });
    }
    // Balances stay out: the step needs only whether the list is empty.
    expect(mocks.projectFetch).toHaveBeenCalledExactlyOnceWith("/v1/wallets", {
      signal: expect.any(AbortSignal),
    });
  });

  // Greptile (#2727): the step read the default sandbox while its links went to the open
  // project, so another sandbox project read "Created" over an empty wallet list.
  it("leaves the wallet step open in a project with no wallets", async () => {
    mocks.fetch
      .mockResolvedValueOnce(onboarding({ custodyProviders: ["privy"] }))
      .mockResolvedValueOnce({ apiKeys: [] })
      .mockResolvedValueOnce({ apiKeys: [] });
    expect(await loadQuickStartStatus()).toMatchObject({ hasWallet: false });
  });

  it("returns unknown when the open project's wallets cannot be read", async () => {
    mocks.projectFetch.mockRejectedValueOnce(new Error("wallet list unavailable"));
    mocks.fetch
      .mockResolvedValueOnce(onboarding({}))
      .mockResolvedValueOnce({ apiKeys: [] })
      .mockResolvedValueOnce({ apiKeys: [] });
    expect(await loadQuickStartStatus()).toBeNull();
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

  it("returns unknown when the API answers with a shape the guide does not understand", async () => {
    mocks.fetch.mockResolvedValueOnce({ linked: true, setup: { canManage: "yes" } });
    expect(await loadQuickStartStatus()).toBeNull();

    mocks.fetch
      .mockResolvedValueOnce(onboarding({}))
      .mockResolvedValueOnce({ apiKeys: "none" })
      .mockResolvedValueOnce({ apiKeys: [] });
    expect(await loadQuickStartStatus()).toBeNull();
  });

  it("returns unknown rather than new when the status request fails", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("offline"));
    expect(await loadQuickStartStatus()).toBeNull();
  });
});
