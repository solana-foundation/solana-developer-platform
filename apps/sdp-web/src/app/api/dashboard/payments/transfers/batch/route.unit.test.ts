import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import { POST } from "./route";

describe("POST /api/dashboard/payments/transfers/batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("selects only Idempotency-Key from inbound headers", async () => {
    const request = new Request("https://dashboard.example.test/api/transfers/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "batch-key",
        Authorization: "Bearer browser-token",
        "X-Do-Not-Forward": "secret",
      },
      body: JSON.stringify({ source: "wallet_1", token: "USDC", recipients: [] }),
    });

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payments.transfers.batch.post",
      path: "/v1/payments/transfer-batches",
      upstreamHeaders: { "Idempotency-Key": "batch-key" },
    });
  });

  it("supplies no client-owned upstream headers when the key is absent", async () => {
    const request = new Request("https://dashboard.example.test/api/transfers/batch", {
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
