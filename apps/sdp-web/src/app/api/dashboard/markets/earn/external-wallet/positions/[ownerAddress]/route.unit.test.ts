import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));
vi.mock("@/lib/sdp-api", () => ({ proxyToSdpApi: mocks.proxyToSdpApi }));

import { GET } from "./route";

describe("GET external-wallet positions proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("forwards the wallet and bounded keyset query", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/positions?before=abc_123&limit=100"
    );
    await GET(request, { params: Promise.resolve({ ownerAddress: "wallet/address" }) });
    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.external_wallet_positions.list",
      path: "/v1/earn/external-wallet/positions?ownerAddress=wallet%2Faddress&limit=100&before=abc_123",
    });
  });

  it.each(["?limit=20&limit=30", "?before=", "?page=2"])(
    "rejects malformed or non-allowlisted query %s",
    async (query) => {
      const response = await GET(
        new Request(`https://dashboard.example.test/api/positions${query}`),
        {
          params: Promise.resolve({ ownerAddress: "wallet" }),
        }
      );
      expect(response.status).toBe(400);
      expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
    }
  );
});
