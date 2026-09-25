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

import { GET, POST } from "./route";

describe("GET /api/dashboard/payments/recurring-payments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it("proxies the list request without forwarding caller headers", async () => {
    const request = new Request(
      "https://dashboard.example/api/dashboard/payments/recurring-payments?page=1"
    );

    await GET(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.recurring-payments.list",
      path: "/v1/payments/recurring-payments?page=1",
    });
    expect(mocks.getSelectedProjectId).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/payments/recurring-payments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 201 }));
  });

  // Without the key a retried create is a second pending_activation row, and
  // activating both schedules duplicates every future debit.
  it("forwards the Idempotency-Key and nothing else from the caller", async () => {
    const request = new Request(
      "https://dashboard.example/api/dashboard/payments/recurring-payments",
      {
        method: "POST",
        headers: { "Idempotency-Key": "recurring-key-1", Cookie: "session=secret" },
      }
    );

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.recurring-payments.create",
      path: "/v1/payments/recurring-payments",
      upstreamHeaders: { "Idempotency-Key": "recurring-key-1" },
    });
  });

  it("forwards no key when the caller sent none", async () => {
    const request = new Request(
      "https://dashboard.example/api/dashboard/payments/recurring-payments",
      {
        method: "POST",
      }
    );

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamHeaders: undefined })
    );
  });
});
