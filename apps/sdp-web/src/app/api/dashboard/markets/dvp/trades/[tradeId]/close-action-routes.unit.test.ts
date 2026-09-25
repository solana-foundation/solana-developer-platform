import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyToSdpApi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sdp-api", () => ({ proxyToSdpApi }));

import { POST as cancel } from "./cancel/route";
import { POST as settle } from "./settle/route";

const params = Promise.resolve({ tradeId: "dvp/1" });

describe("DvP close action proxies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  // Without the key the API signs a second close for a retried settle or
  // cancel instead of replaying the first close's signature.
  it.each([
    ["settle", settle],
    ["cancel", cancel],
  ] as const)(
    "forwards the Idempotency-Key on %s and nothing else from the caller",
    async (action, post) => {
      const request = new Request(`https://dashboard.example/api/x/${action}`, {
        method: "POST",
        headers: { "Idempotency-Key": "dvp-key-1", Cookie: "session=secret" },
      });

      await post(request, { params });

      expect(proxyToSdpApi).toHaveBeenCalledWith({
        request,
        traceSource: `route.dashboard.dvp.trades.${action}`,
        path: `/v1/dvp/trades/dvp%2F1/${action}`,
        upstreamHeaders: { "Idempotency-Key": "dvp-key-1" },
      });
    }
  );

  it.each([
    ["settle", settle],
    ["cancel", cancel],
  ] as const)("forwards no key on %s when the caller sent none", async (action, post) => {
    const request = new Request(`https://dashboard.example/api/x/${action}`, { method: "POST" });

    await post(request, { params });

    expect(proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamHeaders: undefined })
    );
  });
});
