// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { saveOrganizationAlertEmails, saveOrganizationIpAllowlist } from "./organization-settings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("organization settings saves", () => {
  it("patches one canonical entry per address and returns the list as stored", async () => {
    const fetchMock = stubDashboardFetch(() =>
      dashboardDataResponse(200, { settings: { allowedIpAddresses: ["203.0.113.0/24"] } })
    );

    expect(
      await saveOrganizationIpAllowlist("org_sdp", "203.0.113.5/24\n203.0.113.5/24, ", "key_edit")
    ).toEqual({ ok: true, value: ["203.0.113.0/24"] });
    expect(sentDashboardRequests(fetchMock)).toEqual([
      {
        path: "/api/dashboard/organizations/org_sdp",
        method: "PATCH",
        idempotencyKey: "key_edit",
        body: { settings: { allowedIpAddresses: ["203.0.113.5/24"] } },
      },
    ]);
  });

  it("clears the allowlist with an empty list", async () => {
    const fetchMock = stubDashboardFetch(() =>
      dashboardDataResponse(200, { settings: { allowedIpAddresses: [] } })
    );

    await saveOrganizationIpAllowlist("org_sdp", "   ", "key_clear");

    expect(sentDashboardRequests(fetchMock).map((request) => request.body)).toEqual([
      { settings: { allowedIpAddresses: [] } },
    ]);
  });

  it("patches alert emails off and returns the stored value", async () => {
    const fetchMock = stubDashboardFetch(() =>
      dashboardDataResponse(200, { settings: { alertEmails: false } })
    );

    expect(await saveOrganizationAlertEmails("org_sdp", false, "key_alerts_off")).toEqual({
      ok: true,
      value: false,
    });
    expect(sentDashboardRequests(fetchMock)).toEqual([
      {
        path: "/api/dashboard/organizations/org_sdp",
        method: "PATCH",
        idempotencyKey: "key_alerts_off",
        body: { settings: { alertEmails: false } },
      },
    ]);
  });

  it("returns the API's refusal", async () => {
    stubDashboardFetch(() => dashboardErrorResponse(400, "invalid entry"));

    expect(await saveOrganizationIpAllowlist("org_sdp", "office", "key_bad")).toEqual({
      ok: false,
      error: "invalid entry",
    });
  });

  it("refuses an answer it cannot read rather than showing it as saved", async () => {
    stubDashboardFetch(() => dashboardDataResponse(200, { settings: { alertEmails: "no" } }));

    expect((await saveOrganizationAlertEmails("org_sdp", false, "key_unreadable")).ok).toBe(false);
  });
});
