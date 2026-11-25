import { beforeEach, describe, expect, it, vi } from "vitest";
import * as walletActivityServer from "@/app/(session)/dashboard/[projectId]/wallets/wallet-activity.server";
import * as sdpApi from "@/lib/sdp-api";
import { expectDashboardNoStore } from "@/test/dashboard-response";
import { translateServerMessagesToKeys } from "@/test/i18n-server";

// The deployment's Issuance flag, read by the loader's module; the spy below stands in for the loader.
vi.mock("@/flags", () => ({ issuance: vi.fn() }));

import { GET } from "./route";

const EMPTY_ACTIVITY = {
  activityRows: [],
  activityError: null,
  activityNotice: null,
  hasMore: false,
};

const apiRequest = vi.fn<sdpApi.SdpApiClient["request"]>();
const createSdpApiClient = vi.spyOn(sdpApi, "createSdpApiClient");
const loadWalletActivity = vi.spyOn(walletActivityServer, "loadWalletActivity");

function walletMetadata(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function getActivity(walletId: string, search = ""): Promise<Response> {
  return GET(
    new Request(
      `https://dashboard.example.com/api/dashboard/wallets/${walletId}/activity${search}`
    ),
    { params: Promise.resolve({ walletId }) }
  );
}

beforeEach(() => {
  translateServerMessagesToKeys();
  apiRequest.mockReset();
  createSdpApiClient.mockReset().mockResolvedValue({ request: apiRequest, fetch: vi.fn() });
  loadWalletActivity.mockReset().mockResolvedValue({ ok: true, data: EMPTY_ACTIVITY });
});

describe("GET /api/dashboard/wallets/:walletId/activity", () => {
  // The wallet read is the Project gate: a wallet sdp-api does not show this Project has no activity.
  it("answers the wallet's 404 without reading any activity", async () => {
    apiRequest.mockResolvedValue(
      walletMetadata(JSON.stringify({ error: { message: "Wallet not found" } }), 404)
    );

    const response = await getActivity("cwlt_1");

    expect(response.status).toBe(404);
    expectDashboardNoStore(response);
    expect(await response.json()).toEqual({ error: { message: "Wallet not found" } });
    expect(apiRequest.mock.calls).toEqual([["/v1/wallets/cwlt_1?includeBalance=false"]]);
    expect(loadWalletActivity).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "not JSON"],
    ["a missing custody wallet ID", JSON.stringify({ data: { wallet: { walletId: "privy_1" } } })],
    [
      "an empty custody wallet ID",
      JSON.stringify({ data: { wallet: { id: "  ", walletId: "privy_1" } } }),
    ],
    ["a missing provider wallet ID", JSON.stringify({ data: { wallet: { id: "cwlt_1" } } })],
    [
      "an empty provider wallet ID",
      JSON.stringify({ data: { wallet: { id: "cwlt_1", walletId: "  " } } }),
    ],
  ])("returns 502 without loading activity for %s", async (_case, body) => {
    apiRequest.mockResolvedValue(walletMetadata(body));

    const response = await getActivity("cwlt_1");

    expect(response.status).toBe(502);
    expectDashboardNoStore(response);
    expect(await response.json()).toEqual({
      error: { message: "DashboardCustody.walletActivityRequestFailed" },
    });
    expect(loadWalletActivity).not.toHaveBeenCalled();
  });

  it.each([
    ["no limit", "", 20],
    ["a widened window", "?limit=220", 220],
    ["the largest window", "?limit=500", 500],
    ["a window past the largest", "?limit=501", 20],
    ["a non-numeric limit", "?limit=all", 20],
  ])("reads %s as a window of %s rows", async (_case, search, pageSize) => {
    apiRequest.mockResolvedValue(
      walletMetadata(JSON.stringify({ data: { wallet: { id: "cwlt_1", walletId: "privy_1" } } }))
    );

    const response = await getActivity("cwlt_1", search);

    expect(response.status).toBe(200);
    expectDashboardNoStore(response);
    expect(await response.json()).toEqual({ data: EMPTY_ACTIVITY });
    expect(loadWalletActivity).toHaveBeenCalledExactlyOnceWith(
      apiRequest,
      { custodyWalletId: "cwlt_1", providerWalletId: "privy_1" },
      expect.any(Function),
      { pageSize }
    );
  });

  it("refuses a malformed wallet ID before calling sdp-api", async () => {
    const response = await getActivity("%E0");

    expect(response.status).toBe(400);
    expectDashboardNoStore(response);
    expect(await response.json()).toEqual({
      error: { message: "DashboardCustody.invalidWalletId" },
    });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("marks an unexpected failure uncacheable", async () => {
    createSdpApiClient.mockRejectedValue(new Error("client unavailable"));

    const response = await getActivity("cwlt_1");

    expect(response.status).toBe(500);
    expectDashboardNoStore(response);
    expect(await response.json()).toEqual({ error: { message: "client unavailable" } });
  });
});
