import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
  proxyFailure: vi.fn(),
  createSdpApiClient: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
  proxyFailure: mocks.proxyFailure,
  createSdpApiClient: mocks.createSdpApiClient,
}));

vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: () => "trace",
  logRouteResult: vi.fn(),
}));

import { GET, POST } from "./route";

describe("GET /api/dashboard/payments/transfers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it.each(["?custodyWalletId=cwlt_1&includeObserved=true", "?wallet=provider-wallet"])(
    "passes the filtered query %s straight to the SDP API to accept or reject",
    async (query) => {
      const request = new Request(
        `https://dashboard.example/api/dashboard/payments/transfers${query}`
      );

      await GET(request);

      expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
        request,
        traceSource: "route.dashboard.payments.transfers.get",
        path: `/v1/payments/transfers${query}`,
      });
    }
  );

  it("refuses the unfiltered aggregate without the tab's Project header", async () => {
    mocks.proxyFailure.mockReturnValue(new Response(null, { status: 400 }));

    const response = await GET(
      new Request("https://dashboard.example/api/dashboard/payments/transfers")
    );

    expect(response.status).toBe(400);
    expect(mocks.proxyFailure).toHaveBeenCalledWith("trace", 400, "x-project-id header required");
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/payments/transfers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 202 }));
  });

  // Without the key a retried send is a new payment.
  it("forwards the Idempotency-Key and nothing else from the caller", async () => {
    const request = new Request("https://dashboard.example/api/dashboard/payments/transfers", {
      method: "POST",
      headers: { "Idempotency-Key": "transfer-key-1", Cookie: "session=secret" },
    });

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payments.transfers.post",
      path: "/v1/payments/transfers",
      upstreamHeaders: { "Idempotency-Key": "transfer-key-1" },
    });
  });

  it("forwards no key when the caller sent none", async () => {
    const request = new Request("https://dashboard.example/api/dashboard/payments/transfers", {
      method: "POST",
    });

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamHeaders: undefined })
    );
  });
});
