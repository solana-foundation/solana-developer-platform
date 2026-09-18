import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));

vi.mock("@/lib/sdp-api", () => ({ proxyToSdpApi: mocks.proxyToSdpApi }));

import { POST } from "./route";

describe("POST queued-withdrawal cancellation proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("encodes the id and forwards only Idempotency-Key", async () => {
    const request = new Request("https://dashboard.example.test/api/cancel", {
      method: "POST",
      headers: { "Idempotency-Key": "cancel-key", Authorization: "secret" },
      body: "{}",
    });

    await POST(request, {
      params: Promise.resolve({ withdrawalRequestId: "request/with slash" }),
    });

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.vault_withdrawal_requests.cancel",
      path: "/v1/earn/vault-withdrawal-requests/request%2Fwith%20slash/cancel",
      upstreamHeaders: { "Idempotency-Key": "cancel-key" },
    });
  });
});
