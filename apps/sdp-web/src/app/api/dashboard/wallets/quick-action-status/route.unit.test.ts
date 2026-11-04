import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  createOrgSdpApiClient: vi.fn(),
  createSdpApiClient: vi.fn(),
}));

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createOrgSdpApiClient: mocks.createOrgSdpApiClient,
  createSdpApiClient: mocks.createSdpApiClient,
}));

import { GET } from "./route";

function onboarding(linked: boolean) {
  mocks.createOrgSdpApiClient.mockResolvedValue({ fetch: vi.fn().mockResolvedValue({ linked }) });
}

const withoutProject = () =>
  new Request("https://dashboard.example/api/dashboard/wallets/quick-action-status");

describe("GET /api/dashboard/wallets/quick-action-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
  });

  it("answers an unlinked organization without a Project with the linked:false payload", async () => {
    onboarding(false);

    const response = await GET(withoutProject());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      custodyEnabled: false,
      walletProvisioningEnabled: false,
      walletProvisioningReason: "Enable wallets first in the custody providers section.",
      walletProvisioningProviders: [],
    });
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
  });

  it("refuses a linked organization's call without the tab's Project", async () => {
    onboarding(true);

    const response = await GET(withoutProject());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: "x-project-id header required" } });
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
  });
});
