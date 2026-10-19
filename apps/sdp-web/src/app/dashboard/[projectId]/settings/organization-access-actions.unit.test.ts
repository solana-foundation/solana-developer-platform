import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import {
  loadOrganizationIpAllowlist,
  saveOrganizationIpAllowlistAction,
} from "./organization-access-actions";

const fetchMock = vi.spyOn(globalThis, "fetch");

/** Answers the onboarding read and the organization read or write through the real client. */
function answer(organization: unknown, status = 200) {
  fetchMock.mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const data = url.endsWith("/v1/onboarding/status")
      ? { linked: true, organization: { id: "org_sdp" } }
      : organization;
    return Response.json(
      status === 200 ? { data } : { error: { code: "BAD_REQUEST", message: "invalid entry" } },
      { status: url.endsWith("/v1/onboarding/status") ? 200 : status }
    );
  });
}

function organizationCall(): { url: string; init: RequestInit | undefined } {
  const call = fetchMock.mock.calls.find(([input]) =>
    String(input instanceof Request ? input.url : input).endsWith("/v1/organizations/org_sdp")
  );
  if (!call) throw new Error("No organization request was sent");
  return { url: String(call[0]), init: call[1] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SDP_API_BASE_URL", "https://api.sdp.test");
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/settings`);
  vi.spyOn(sdpApi, "createOrgSdpApiClient").mockImplementation(async () =>
    sdpApi.createTokenSdpApiClient("test-session-token")
  );
});

describe("organization IP allowlist", () => {
  it("loads the stored allowlist, empty when unrestricted", async () => {
    answer({ settings: {} });

    expect(await loadOrganizationIpAllowlist()).toEqual({
      ok: true,
      organizationId: "org_sdp",
      allowedIps: [],
    });
  });

  it("saves one entry per address and returns the list as stored", async () => {
    answer({ settings: { allowedIpAddresses: ["203.0.113.0/24"] } });

    const result = await saveOrganizationIpAllowlistAction(
      "203.0.113.5/24\n203.0.113.5/24, ",
      "key_allowlist_edit"
    );

    expect(result).toEqual({ ok: true, allowedIps: ["203.0.113.0/24"] });
    const { init } = organizationCall();
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("key_allowlist_edit");
    expect(JSON.parse(String(init?.body))).toEqual({
      settings: { allowedIpAddresses: ["203.0.113.5/24"] },
    });
  });

  it("clears the allowlist with an empty list", async () => {
    answer({ settings: { allowedIpAddresses: [] } });

    await saveOrganizationIpAllowlistAction("   ", "key_allowlist_clear");

    expect(JSON.parse(String(organizationCall().init?.body))).toEqual({
      settings: { allowedIpAddresses: [] },
    });
  });

  it("reports an API refusal without throwing", async () => {
    answer(null, 400);

    expect((await saveOrganizationIpAllowlistAction("office", "key_allowlist_bad")).ok).toBe(false);
  });

  it("refuses a response it cannot read rather than showing it as unrestricted", async () => {
    answer({ settings: { allowedIpAddresses: "203.0.113.0/24" } });

    expect((await loadOrganizationIpAllowlist()).ok).toBe(false);
  });
});
