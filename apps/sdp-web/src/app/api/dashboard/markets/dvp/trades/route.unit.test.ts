import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyToSdpApi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sdp-api", () => ({ proxyToSdpApi }));

import { GET as listInbound } from "./inbound/route";
import { GET as listTrades } from "./route";

beforeEach(() => {
  proxyToSdpApi.mockReset();
  proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
});

describe("GET /api/dashboard/markets/dvp/trades/inbound", () => {
  it("proxies the trades waiting on the caller", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/markets/dvp/trades/inbound"
    );

    await listInbound(request);

    expect(proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.dvp.trades.inbound",
      path: "/v1/dvp/trades/inbound",
    });
  });
});

describe("GET /api/dashboard/markets/dvp/trades", () => {
  it("forwards the page size and every list filter", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/markets/dvp/trades?limit=50&q=ATD&settlementAvailability=available&status=funded"
    );

    await listTrades(request);

    expect(proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.dvp.trades.list",
      path: "/v1/dvp/trades?limit=50&q=ATD&settlementAvailability=available&status=funded",
    });
  });

  it.each([
    ["?status=funded&status=settled", "Repeated query parameter: status"],
    ["?q=ATD&q=TBOND", "Repeated query parameter: q"],
    ["?cursor=abc", "Unsupported query parameter: cursor"],
    ["?limit=101", "limit must be an integer between 1 and 100"],
  ])("refuses %s without reaching the API", async (query, message) => {
    const response = await listTrades(
      new Request(`https://dashboard.example.test/api/dashboard/markets/dvp/trades${query}`)
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message } });
    expect(proxyToSdpApi).not.toHaveBeenCalled();
  });
});
