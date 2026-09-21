import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));

vi.mock("@/lib/sdp-api", () => ({ proxyToSdpApi: mocks.proxyToSdpApi }));

import { GET, POST } from "./route";

describe("dashboard queued-withdrawal request proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("forwards only the idempotency key on create", async () => {
    const request = new Request("https://dashboard.example.test/api/requests", {
      method: "POST",
      headers: {
        "Idempotency-Key": "queue-key",
        Authorization: "Bearer browser-token",
        "X-Do-Not-Forward": "secret",
      },
      body: "{}",
    });

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.vault_withdrawal_requests.create",
      path: "/v1/earn/vault-withdrawal-requests",
      upstreamHeaders: { "Idempotency-Key": "queue-key" },
    });
  });

  it("strictly validates and canonicalizes the list query", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/requests?status=expiredCancelable&settled=false&before=abc_123&limit=50"
    );

    await GET(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.vault_withdrawal_requests.list",
      path: "/v1/earn/vault-withdrawal-requests?limit=50&before=abc_123&status=expiredCancelable&settled=false",
    });
  });

  it("rejects a non-boolean settled filter", async () => {
    const request = new Request("https://dashboard.example.test/api/requests?settled=0");

    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });

  it("rejects unknown query parameters", async () => {
    const request = new Request("https://dashboard.example.test/api/requests?ownerAddress=nope");

    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });
});
