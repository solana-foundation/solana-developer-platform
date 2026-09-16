import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyToSdpApi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sdp-api", () => ({ proxyToSdpApi }));

import { POST as fund } from "./fund/route";
import { POST as reclaim } from "./reclaim/route";

const params = Promise.resolve({ tradeId: "dvp/1" });

describe("DvP leg action proxies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  // Without the key a retried request is a second transfer, not a replay.
  it.each([
    ["fund", fund],
    ["reclaim", reclaim],
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

  it("forwards no key when the caller sent none", async () => {
    const request = new Request("https://dashboard.example/api/x/fund", { method: "POST" });

    await fund(request, { params });

    expect(proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamHeaders: undefined })
    );
  });
});
