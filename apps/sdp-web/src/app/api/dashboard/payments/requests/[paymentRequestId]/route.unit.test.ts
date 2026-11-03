import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import { GET } from "./route";

function detailRequest(): Request {
  return new Request("https://dashboard.example.com/api/dashboard/payments/requests/preq_1");
}

describe("GET /api/dashboard/payments/requests/[paymentRequestId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the request from the API", async () => {
    mocks.proxyToSdpApi.mockResolvedValue(Response.json({ data: {} }));
    const request = detailRequest();

    await GET(request, { params: Promise.resolve({ paymentRequestId: "preq_1" }) });

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payment-requests.detail",
      path: "/v1/payments/requests/preq_1",
    });
  });

  it("returns 400 for a blank id without proxying", async () => {
    const response = await GET(detailRequest(), {
      params: Promise.resolve({ paymentRequestId: " " }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Payment request id is required" },
    });
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });
});
