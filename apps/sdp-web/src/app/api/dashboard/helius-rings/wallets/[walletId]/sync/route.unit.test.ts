import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import * as route from "./route";

describe("POST /api/dashboard/helius-rings/wallets/[walletId]/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("proxies an explicitly encoded wallet sync with its own trace source", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/helius-rings/wallets/wallet/sync",
      { method: "POST" }
    );

    await route.POST(request, {
      params: Promise.resolve({ walletId: "wallet/with space" }),
    });

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.helius-rings.sync",
      path: "/v1/helius-rings/wallets/wallet%2Fwith%20space/sync",
    });
  });

  it("does not expose a GET handler", () => {
    expect(route).not.toHaveProperty("GET");
  });
});
