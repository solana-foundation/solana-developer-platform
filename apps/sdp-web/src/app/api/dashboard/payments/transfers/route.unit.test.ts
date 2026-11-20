import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { expectDashboardNoStore } from "@/test/dashboard-response";
import { GET, POST } from "./route";

const TRANSFER = {
  id: "xfr_1",
  custodyWalletId: "cwlt_1",
  providerWalletId: "wallet_1",
  status: "confirmed",
  signature: "signature_1",
  rampsMemo: {},
  createdAt: "2026-11-01T10:00:00.000Z",
};

const aggregateRequest = (query = "") =>
  new Request(`https://dashboard.example/api/dashboard/payments/transfers${query}`, {
    headers: { "x-project-id": "proj_1" },
  });

/** Answers the aggregate's upstream reads through the real client: the transfer list, and no wallets. */
function answerUpstream(transfers: () => Response) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.pathname === "/v1/wallets" ? Response.json({ data: { wallets: [] } }) : transfers();
  });
  vi.spyOn(sdpApi, "createSdpApiClient").mockImplementation(async () =>
    sdpApi.createTokenSdpApiClient("test-session-token")
  );
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv("SDP_API_BASE_URL", "https://api.sdp.test");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/dashboard/payments/transfers", () => {
  it("passes a filtered query straight to the SDP API to accept or reject", async () => {
    const proxy = vi
      .spyOn(sdpApi, "proxyToSdpApi")
      .mockResolvedValue(NextResponse.json({ data: [] }));
    const request = new Request(
      "https://dashboard.example/api/dashboard/payments/transfers?custodyWalletId=cwlt_1&includeObserved=true"
    );

    await GET(request);

    expect(proxy).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payments.transfers.get",
      path: "/v1/payments/transfers?custodyWalletId=cwlt_1&includeObserved=true",
    });
  });

  it("refuses the unfiltered aggregate without the tab's Project header", async () => {
    const createClient = vi.spyOn(sdpApi, "createSdpApiClient");

    const response = await GET(
      new Request("https://dashboard.example/api/dashboard/payments/transfers")
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: "x-project-id header required" } });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("lists the aggregate at the page size asked for, uncacheable", async () => {
    const fetchMock = answerUpstream(() => Response.json({ data: [TRANSFER] }));

    const response = await GET(aggregateRequest("?pageSize=5"));

    expect(response.status).toBe(200);
    expectDashboardNoStore(response);
    expect(await response.json()).toEqual({ data: [TRANSFER] });
    expect(fetchMock.mock.calls.map(([input]) => String(input)).sort()).toEqual([
      "https://api.sdp.test/v1/payments/transfers?page=1&pageSize=5&includeObserved=false",
      "https://api.sdp.test/v1/wallets?view=summary",
    ]);
  });

  it("relays the API's refusal of the aggregate with its status, uncacheable", async () => {
    answerUpstream(() =>
      Response.json({ error: { message: "Transfers unavailable" } }, { status: 503 })
    );

    const response = await GET(aggregateRequest());

    expect(response.status).toBe(503);
    expectDashboardNoStore(response);
    expect(await response.json()).toEqual({ error: { message: "Transfers unavailable" } });
  });

  it("answers a 500, uncacheable, when the aggregate cannot reach the API", async () => {
    vi.spyOn(sdpApi, "createSdpApiClient").mockRejectedValue(new Error("client unavailable"));

    const response = await GET(aggregateRequest());

    expect(response.status).toBe(500);
    expectDashboardNoStore(response);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: { message: "Transfer list request failed" } });
    expect(body).not.toContain("client unavailable");
  });
});

describe("POST /api/dashboard/payments/transfers", () => {
  // Without the key a retried send is a new payment; the proxy forwards it.
  it("leaves the Idempotency-Key to proxyToSdpApi and adds no upstream headers", async () => {
    const proxy = vi
      .spyOn(sdpApi, "proxyToSdpApi")
      .mockResolvedValue(NextResponse.json({ data: {} }, { status: 201 }));
    const request = new Request("https://dashboard.example/api/dashboard/payments/transfers", {
      method: "POST",
      headers: { "Idempotency-Key": "transfer-key-1" },
    });

    await POST(request);

    expect(proxy).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payments.transfers.post",
      path: "/v1/payments/transfers",
    });
  });
});
