import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { SANDBOX_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import { loadOrganizationProviderAccess } from "./payments-provider-access.server";

/** What the onboarding endpoint answers here: a real status, or one naming a malformed id. */
type OnboardingStatusAnswer = {
  linked: boolean;
  organization: { id: string | number } | null;
};

const RAMP_ACCESS = { moonpay: { entitled: true, configured: true, enabled: true } };

const fetchMock = vi.spyOn(globalThis, "fetch");

/** Answers the onboarding read and the provider-access read through the real client. */
function answer(onboarding: OnboardingStatusAnswer) {
  fetchMock.mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const data = url.endsWith("/v1/onboarding/status")
      ? onboarding
      : { tier: "enterprise", providers: { compliance: {}, ramps: RAMP_ACCESS } };
    return Response.json({ data });
  });
}

function providerAccessUrls(): string[] {
  return fetchMock.mock.calls
    .map(([input]) => (input instanceof Request ? input.url : String(input)))
    .filter((url) => url.endsWith("/provider-access"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SDP_API_BASE_URL", "https://api.sdp.test");
  setPageRequest(`/dashboard/${SANDBOX_PROJECT.id}/payments`);
  vi.spyOn(sdpApi, "createOrgSdpApiClient").mockImplementation(async () =>
    sdpApi.createTokenSdpApiClient("test-session-token")
  );
});

describe("loadOrganizationProviderAccess", () => {
  it("reads provider access under the organization id the onboarding status names", async () => {
    answer({ linked: true, organization: { id: "org_sdp" } });

    expect(await loadOrganizationProviderAccess()).toMatchObject({
      rampProviderAccess: RAMP_ACCESS,
    });
    expect(providerAccessUrls()).toEqual([
      "https://api.sdp.test/v1/organizations/org_sdp/provider-access",
    ]);
  });

  it("asks for nothing when the onboarding status names no organization", async () => {
    answer({ linked: false, organization: null });

    expect(await loadOrganizationProviderAccess()).toBeNull();
    expect(providerAccessUrls()).toEqual([]);
  });

  it("asks for nothing when the onboarding status is malformed", async () => {
    answer({ linked: true, organization: { id: 42 } });

    expect(await loadOrganizationProviderAccess()).toBeNull();
    expect(providerAccessUrls()).toEqual([]);
  });
});
