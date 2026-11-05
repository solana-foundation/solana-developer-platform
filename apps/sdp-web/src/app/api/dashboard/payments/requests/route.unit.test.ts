import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));
vi.mock("@/lib/sdp-api", () => mocks);

import { GET } from "./route";

describe("GET /api/dashboard/payments/requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("passes the list's page, size and status straight to the SDP API", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/payments/requests?page=2&pageSize=25&status=paid"
    );

    await GET(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payments.requests.list",
      path: "/v1/payments/requests?page=2&pageSize=25&status=paid",
    });
  });
});
