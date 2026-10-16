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
    "leaves the Idempotency-Key to proxyToSdpApi and adds no upstream headers on %s",
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
      });
    }
  );
});
