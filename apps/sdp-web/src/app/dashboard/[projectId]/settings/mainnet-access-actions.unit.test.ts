import { SDP_TERMS } from "@sdp/types/mainnet-access";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import { loadMainnetAccess, requestMainnetAccessAction } from "./mainnet-access-actions";

const fetchMock = vi.spyOn(globalThis, "fetch");

const PENDING = {
  state: "pending",
  countryCode: "SG",
  termsAcceptance: {
    version: SDP_TERMS.version,
    acceptedAt: "2026-10-30T00:00:00.000Z",
    acceptedByUserId: "usr_admin",
  },
  request: {
    requestedAt: "2026-10-30T00:00:00.000Z",
    requestedByUserId: "usr_admin",
    notified: true,
  },
  currentTerms: SDP_TERMS,
  contactEmail: "sdp@example.org",
};

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

function answer(mainnetAccess: unknown, status = 200) {
  fetchMock.mockImplementation(async (input) => {
    const url = urlOf(input);
    if (url.endsWith("/v1/onboarding/status")) {
      return Response.json({ data: { linked: true, organization: { id: "org_sdp" } } });
    }
    if (url.endsWith("/v1/organizations/org_sdp")) {
      return Response.json({ data: { name: "Acme" } });
    }
    return Response.json(
      status < 400
        ? { data: mainnetAccess }
        : {
            error: {
              code: "CONFLICT",
              message: "This organization already requested mainnet access",
            },
          },
      { status }
    );
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

describe("mainnet access actions", () => {
  it("loads the organization's request with its name", async () => {
    answer(PENDING);
    expect(await loadMainnetAccess()).toEqual({
      ok: true,
      organizationName: "Acme",
      access: PENDING,
    });
  });

  it("posts the jurisdiction and the accepted terms version", async () => {
    answer(PENDING, 201);
    expect(
      await requestMainnetAccessAction({ countryCode: "SG", termsVersion: SDP_TERMS.version })
    ).toEqual({ ok: true, access: PENDING });

    const post = fetchMock.mock.calls.find(([input]) =>
      urlOf(input).endsWith("/v1/organizations/org_sdp/mainnet-access")
    );
    expect(post?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      countryCode: "SG",
      termsVersion: SDP_TERMS.version,
      acceptTerms: true,
    });
    expect(mocks.revalidatePath).toHaveBeenCalled();
  });

  it("returns the API's refusal", async () => {
    answer(null, 409);
    const result = await requestMainnetAccessAction({
      countryCode: "SG",
      termsVersion: SDP_TERMS.version,
    });
    expect(result.ok).toBe(false);
  });
});
