import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
  getSelectedProjectId: vi.fn(),
  createSdpApiClient: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
  getSelectedProjectId: mocks.getSelectedProjectId,
  createSdpApiClient: mocks.createSdpApiClient,
}));

vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: vi.fn(),
  logRouteResult: vi.fn(),
}));

import { GET } from "./route";

describe("GET /api/dashboard/payments/transfers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it("passes an exact custody wallet filter directly to the SDP API", async () => {
    const request = new Request(
      "https://dashboard.example/api/dashboard/payments/transfers?custodyWalletId=cwlt_1&includeObserved=true"
    );

    await GET(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payments.transfers.get",
      path: "/v1/payments/transfers?custodyWalletId=cwlt_1&includeObserved=true",
    });
    expect(mocks.getSelectedProjectId).not.toHaveBeenCalled();
  });

  it("passes a removed wallet filter through so the SDP API rejects it", async () => {
    const request = new Request(
      "https://dashboard.example/api/dashboard/payments/transfers?wallet=provider-wallet"
    );

    await GET(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payments.transfers.get",
      path: "/v1/payments/transfers?wallet=provider-wallet",
    });
    expect(mocks.getSelectedProjectId).not.toHaveBeenCalled();
  });
});
