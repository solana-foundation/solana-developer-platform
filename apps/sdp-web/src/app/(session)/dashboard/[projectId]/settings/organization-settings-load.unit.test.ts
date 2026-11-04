import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import {
  loadOrganizationAlertEmails,
  loadOrganizationIpAllowlist,
} from "./organization-settings-load";

const fetchMock = vi.spyOn(globalThis, "fetch");

function answer(organization: unknown) {
  fetchMock.mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const data = url.endsWith("/v1/onboarding/status")
      ? { linked: true, organization: { id: "org_sdp" } }
      : organization;
    return Response.json({ data });
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

describe("loadOrganizationIpAllowlist", () => {
  it("loads the stored allowlist, empty when unrestricted", async () => {
    answer({ settings: {} });

    expect(await loadOrganizationIpAllowlist()).toEqual({
      ok: true,
      organizationId: "org_sdp",
      allowedIps: [],
    });
  });

  it("refuses a response it cannot read rather than showing it as unrestricted", async () => {
    answer({ settings: { allowedIpAddresses: "203.0.113.0/24" } });

    expect((await loadOrganizationIpAllowlist()).ok).toBe(false);
  });
});

describe("loadOrganizationAlertEmails", () => {
  it.each([
    [{ settings: {} }, true],
    [{ settings: null }, true],
    [{ settings: { alertEmails: true } }, true],
    [{ settings: { alertEmails: false } }, false],
  ])("reads %j as enabled=%s, on unless turned off", async (organization, enabled) => {
    answer(organization);

    expect(await loadOrganizationAlertEmails()).toEqual({
      ok: true,
      organizationId: "org_sdp",
      enabled,
    });
  });

  it("refuses a response it cannot read rather than showing alerts as on", async () => {
    answer({ settings: { alertEmails: "no" } });

    expect((await loadOrganizationAlertEmails()).ok).toBe(false);
  });
});
