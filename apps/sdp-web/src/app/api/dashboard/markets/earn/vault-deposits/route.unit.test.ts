import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import { POST } from "./route";

describe("POST /api/dashboard/markets/earn/vault-deposits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("selects only Idempotency-Key from inbound headers", async () => {
    const request = new Request("https://dashboard.example.test/api/vault-deposits", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "deposit-key",
        Authorization: "Bearer browser-token",
        "X-Do-Not-Forward": "secret",
      },
      body: JSON.stringify({ strategyId: "strategy_1", amount: "1" }),
    });

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.vault_deposits.create",
      path: "/v1/earn/vault-deposits",
      upstreamHeaders: { "Idempotency-Key": "deposit-key" },
    });
  });

  it("supplies no client-owned upstream headers when the key is absent", async () => {
    const request = new Request("https://dashboard.example.test/api/vault-deposits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamHeaders: undefined })
    );
  });
});
