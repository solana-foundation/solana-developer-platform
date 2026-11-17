import { SDP_TERMS } from "@sdp/types/mainnet-access";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import { loadMainnetAccess } from "./mainnet-access-load";

const fetchMock = vi.spyOn(globalThis, "fetch");

const PENDING = {
  state: "pending",
  available: true,
  sandboxOnly: false,
  mainnetOnly: false,
  countryCode: "SG",
  request: {
    requestedAt: "2026-10-30T00:00:00.000Z",
    requestedByUserId: "usr_admin",
    termsVersion: SDP_TERMS.version,
    notified: true,
  },
  contactEmail: "sdp@example.org",
};

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

function answer(mainnetAccess: unknown) {
  fetchMock.mockImplementation(async (input) => {
    const url = urlOf(input);
    if (url.endsWith("/v1/onboarding/status")) {
      return Response.json({ data: { linked: true, organization: { id: "org_sdp" } } });
    }
    if (url.endsWith("/v1/organizations/org_sdp")) {
      return Response.json({ data: { name: "Acme" } });
    }
    return Response.json({ data: mainnetAccess });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SDP_API_BASE_URL", "https://api.sdp.test");
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/settings`);
  vi.spyOn(sdpApi, "createOrgSdpApiClient").mockImplementation(async () =>
    sdpApi.createTokenSdpApiClient("test-session-token")
  );
});

describe("loadMainnetAccess", () => {
  it("loads the organization's request with its name", async () => {
    answer(PENDING);
    expect(await loadMainnetAccess()).toEqual({
      ok: true,
      organizationId: "org_sdp",
      organizationName: "Acme",
      access: PENDING,
    });
  });
});
