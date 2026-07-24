import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrgSdpApiClient: vi.fn(),
  initializeOnboardingCustodyAction: vi.fn(),
  updateOrganizationRpcSettingsAction: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));
vi.mock("@/app/dashboard/custody/actions", () => ({
  initializeOnboardingCustodyAction: mocks.initializeOnboardingCustodyAction,
}));
vi.mock("@/app/dashboard/settings/actions", () => ({
  updateOrganizationRpcSettingsAction: mocks.updateOrganizationRpcSettingsAction,
}));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/lib/sdp-api", () => ({
  createOrgSdpApiClient: mocks.createOrgSdpApiClient,
}));

import { completeOrganizationOnboardingAction } from "./actions";

beforeEach(() => {
  mocks.createOrgSdpApiClient.mockReset();
  mocks.initializeOnboardingCustodyAction.mockReset();
  mocks.updateOrganizationRpcSettingsAction.mockReset();

  mocks.createOrgSdpApiClient.mockResolvedValue({
    fetch: vi.fn().mockResolvedValue({}),
  });
  mocks.initializeOnboardingCustodyAction.mockResolvedValue({ status: "success" });
});

describe("completeOrganizationOnboardingAction", () => {
  it("does not create a custody wallet when saving the automatic default RPC fails", async () => {
    mocks.createOrgSdpApiClient.mockResolvedValue({
      fetch: vi.fn().mockResolvedValue({
        linked: true,
        organization: { id: "org_test" },
        setup: { rpcProvider: null },
      }),
    });
    mocks.updateOrganizationRpcSettingsAction.mockResolvedValue({
      message: "Default RPC is unavailable",
      status: "error",
    });

    const result = await completeOrganizationOnboardingAction({
      custodyProvider: "para",
      useDefaultRpc: true,
    });

    expect(result).toEqual({
      message: "Default RPC is unavailable",
      status: "error",
    });
    const formData = mocks.updateOrganizationRpcSettingsAction.mock.calls[0]?.[0] as FormData;
    expect(formData.get("organizationId")).toBe("org_test");
    expect(formData.get("rpcProvider")).toBe("default");
    expect(mocks.initializeOnboardingCustodyAction).not.toHaveBeenCalled();
  });

  it("does not replace an RPC provider saved after the default path was rendered", async () => {
    mocks.createOrgSdpApiClient.mockResolvedValue({
      fetch: vi.fn().mockResolvedValue({
        linked: true,
        organization: { id: "org_test" },
        setup: { rpcProvider: "helius" },
      }),
    });

    const result = await completeOrganizationOnboardingAction({
      custodyProvider: "para",
      useDefaultRpc: true,
    });

    expect(result).toEqual({ status: "success" });
    expect(mocks.updateOrganizationRpcSettingsAction).not.toHaveBeenCalled();
    expect(mocks.initializeOnboardingCustodyAction).toHaveBeenCalledOnce();
  });
});
