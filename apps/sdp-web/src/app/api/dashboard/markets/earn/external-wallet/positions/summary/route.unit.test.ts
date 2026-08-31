import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));
vi.mock("@/lib/sdp-api", () => ({ proxyToSdpApi: mocks.proxyToSdpApi }));

import { GET } from "./route";

describe("GET external-wallet position summary proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("proxies the unpaginated aggregate", async () => {
    const request = new Request("https://dashboard.example.test/api/positions/summary");
    await GET(request);
    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.external_wallet_positions.summary",
      path: "/v1/earn/external-wallet/positions/summary",
    });
  });

  it("rejects every query parameter", async () => {
    const response = await GET(
      new Request("https://dashboard.example.test/api/positions/summary?limit=100")
    );
    expect(response.status).toBe(400);
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });
});
