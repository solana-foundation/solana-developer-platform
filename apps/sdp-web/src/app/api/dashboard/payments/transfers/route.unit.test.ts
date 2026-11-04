import { beforeEach, describe, expect, it, vi } from "vitest";
import * as paymentsPageData from "@/app/(session)/dashboard/[projectId]/payments/payments-page.data";
import { expectDashboardNoStore } from "@/test/dashboard-response";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
  proxyFailure: vi.fn(),
  createSdpApiClient: vi.fn(),
}));

const trace = {
  traceId: "trace_test",
  serverTiming: () => "app;dur=1",
  childContext: () => undefined,
};

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
  proxyFailure: mocks.proxyFailure,
  createSdpApiClient: mocks.createSdpApiClient,
}));

vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: () => trace,
  logRouteResult: vi.fn(),
}));

import { GET, POST } from "./route";

const fetchDashboardPaymentTransfers = vi.spyOn(paymentsPageData, "fetchDashboardPaymentTransfers");

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
    expect(mocks.proxyFailure).toHaveBeenCalledWith(trace, 400, "x-project-id header required");
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
  });

  const unfiltered = () =>
    new Request("https://dashboard.example/api/dashboard/payments/transfers", {
      headers: { "x-project-id": "proj_1" },
    });

  it("marks the unfiltered aggregate uncacheable and traced", async () => {
    mocks.createSdpApiClient.mockResolvedValue({ request: vi.fn() });
    fetchDashboardPaymentTransfers.mockResolvedValue({ ok: true, data: [], walletsNotLoaded: 0 });

    const response = await GET(unfiltered());

    expect(response.status).toBe(200);
    expectDashboardNoStore(response);
    expect(response.headers.get("X-SDP-Trace-ID")).toBe("trace_test");
    expect(response.headers.get("Server-Timing")).toBe("app;dur=1");
    expect(await response.json()).toEqual({ data: [] });
  });

  it("marks an upstream failure of the aggregate uncacheable", async () => {
    mocks.createSdpApiClient.mockResolvedValue({ request: vi.fn() });
    fetchDashboardPaymentTransfers.mockResolvedValue({
      ok: false,
      status: 503,
      error: "unavailable",
      walletsNotLoaded: null,
    });

    const response = await GET(unfiltered());

    expect(response.status).toBe(503);
    expectDashboardNoStore(response);
    expect(response.headers.get("X-SDP-Trace-ID")).toBe("trace_test");
  });

  it("marks a thrown aggregate failure uncacheable", async () => {
    mocks.createSdpApiClient.mockRejectedValue(new Error("client unavailable"));

    const response = await GET(unfiltered());

    expect(response.status).toBe(500);
    expectDashboardNoStore(response);
    expect(response.headers.get("X-SDP-Trace-ID")).toBe("trace_test");
  });
});

describe("POST /api/dashboard/payments/transfers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 202 }));
  });

  // Without the key a retried send is a new payment.
  it("leaves the Idempotency-Key to proxyToSdpApi and adds no upstream headers", async () => {
    const request = new Request("https://dashboard.example/api/dashboard/payments/transfers", {
      method: "POST",
      headers: { "Idempotency-Key": "transfer-key-1", Cookie: "session=secret" },
    });

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payments.transfers.post",
      path: "/v1/payments/transfers",
    });
  });
});
