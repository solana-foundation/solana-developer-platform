// @vitest-environment jsdom
import { SDP_TERMS } from "@sdp/types/mainnet-access";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { notifyMainnetAccess, requestMainnetAccess } from "./mainnet-access";

const REQUEST_INPUT = {
  countryCode: "SG",
  termsVersion: SDP_TERMS.version,
  foundationContactEmail: "jo@solana.org",
  useCase: null,
} as const;

const PENDING = {
  state: "pending",
  available: true,
  countryCode: "SG",
  request: {
    requestedAt: "2026-10-30T00:00:00.000Z",
    requestedByUserId: "usr_admin",
    termsVersion: SDP_TERMS.version,
    notified: true,
  },
  contactEmail: "sdp@example.org",
};

beforeEach(() => {
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mainnet access requests", () => {
  it("posts the jurisdiction and the accepted terms version", async () => {
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(201, PENDING));

    expect(await requestMainnetAccess("org_sdp", { ...REQUEST_INPUT })).toEqual({
      ok: true,
      access: PENDING,
    });
    expect(sentDashboardRequests(fetchMock)).toEqual([
      {
        path: "/api/dashboard/organizations/org_sdp/mainnet-access",
        method: "POST",
        idempotencyKey: expect.any(String),
        body: {
          countryCode: "SG",
          termsVersion: SDP_TERMS.version,
          acceptTerms: true,
          foundationContactEmail: "jo@solana.org",
          useCase: null,
        },
      },
    ]);
  });

  it("returns the API's refusal", async () => {
    stubDashboardFetch(() =>
      dashboardErrorResponse(409, "This organization already requested mainnet access")
    );

    expect(await requestMainnetAccess("org_sdp", { ...REQUEST_INPUT })).toEqual({
      ok: false,
      error: "This organization already requested mainnet access",
    });
  });

  it("sends an unsent request with a body-less notify", async () => {
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(200, PENDING));

    expect(await notifyMainnetAccess("org_sdp")).toEqual({ ok: true, access: PENDING });
    expect(sentDashboardRequests(fetchMock)).toEqual([
      {
        path: "/api/dashboard/organizations/org_sdp/mainnet-access/notify",
        method: "POST",
        idempotencyKey: expect.any(String),
        body: undefined,
      },
    ]);
  });
});
