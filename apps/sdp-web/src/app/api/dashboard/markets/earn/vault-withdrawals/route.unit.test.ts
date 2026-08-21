import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import { GET, POST } from "./route";

describe("POST /api/dashboard/markets/earn/vault-withdrawals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("selects only Idempotency-Key from inbound headers", async () => {
    const request = new Request("https://dashboard.example.test/api/vault-withdrawals", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "withdrawal-key",
        Authorization: "Bearer browser-token",
        "X-Do-Not-Forward": "secret",
      },
      body: JSON.stringify({ positionId: "earn_position_1", shares: "1" }),
    });

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.vault_withdrawals.create",
      path: "/v1/earn/vault-withdrawals",
      upstreamHeaders: { "Idempotency-Key": "withdrawal-key" },
    });
  });

  it("supplies no client-owned upstream headers when the key is absent", async () => {
    const request = new Request("https://dashboard.example.test/api/vault-withdrawals", {
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

describe("GET /api/dashboard/markets/earn/vault-withdrawals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("forwards the strict allowlisted query, including a slash-bearing requestId", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/vault-withdrawals?limit=50&settled=false&requestId=key%2Fwith%2Fslashes"
    );

    await GET(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.vault_withdrawals.list",
      // The validator emits params in ITS declaration order, not the caller's.
      path: "/v1/earn/vault-withdrawals?limit=50&requestId=key%2Fwith%2Fslashes&settled=false",
    });
  });

  it("400s an unknown query parameter instead of silently reshaping the page", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/vault-withdrawals?direction=withdrawal"
    );

    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });
});
