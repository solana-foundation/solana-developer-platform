import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOrganizationProviderAccess } from "./payments-provider-access.server";

const mocks = vi.hoisted(() => ({
  createOrgSdpApiClient: vi.fn(),
  fetchProviderAvailability: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({ createOrgSdpApiClient: mocks.createOrgSdpApiClient }));
vi.mock(import("@/lib/provider-availability"), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchProviderAvailability: mocks.fetchProviderAvailability,
}));

const orgRequest = vi.fn();

function onboardingStatusAnswers(body: object) {
  mocks.createOrgSdpApiClient.mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(body),
    request: orgRequest,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadOrganizationProviderAccess", () => {
  it("reads provider access under the organization id the onboarding status names", async () => {
    const access = { rampProviderAccess: {} };
    onboardingStatusAnswers({ linked: true, organization: { id: "org_sdp" } });
    mocks.fetchProviderAvailability.mockResolvedValue(access);

    expect(await loadOrganizationProviderAccess()).toBe(access);
    expect(mocks.fetchProviderAvailability).toHaveBeenCalledWith(orgRequest, "org_sdp");
  });

  it("asks for nothing when the onboarding status names no organization", async () => {
    onboardingStatusAnswers({ linked: false, organization: null });

    expect(await loadOrganizationProviderAccess()).toBeNull();
    expect(mocks.fetchProviderAvailability).not.toHaveBeenCalled();
  });

  it("asks for nothing when the onboarding status is malformed", async () => {
    onboardingStatusAnswers({ linked: true, organization: { id: 42 } });

    expect(await loadOrganizationProviderAccess()).toBeNull();
    expect(mocks.fetchProviderAvailability).not.toHaveBeenCalled();
  });
});
