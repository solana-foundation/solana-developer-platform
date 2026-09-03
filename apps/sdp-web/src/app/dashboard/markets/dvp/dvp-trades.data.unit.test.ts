/**
 * Reading trades for the dashboard.
 *
 * Neither loader throws, so the whole burden of telling "this is not there"
 * apart from "we could not find out" falls on the error and status they carry
 * out. Rendering the second as the first tells someone their trade is gone
 * while it is sitting on chain.
 */

import { describe, expect, it, vi } from "vitest";
import { DVP_TRADES_PAGE_SIZE, fetchDvpTrade, fetchDvpTrades, isNotFound } from "./dvp-trades.data";

function ok(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }) as never;
}
function fail(status: number, body: unknown = {}) {
  return vi.fn().mockResolvedValue({ ok: false, status, json: async () => body }) as never;
}

describe("fetchDvpTrades", () => {
  it("returns the trades the API sent", async () => {
    const result = await fetchDvpTrades(ok({ data: { trades: [{ id: "dvp_1" }] } }));

    expect(result.error).toBeNull();
    expect(result.trades).toHaveLength(1);
  });

  // The upstream list is capped and has no cursor, so the page asks for a
  // bounded slice rather than pretending to be a complete ledger.
  it("asks for a bounded page", async () => {
    const request = ok({ data: { trades: [] } });

    await fetchDvpTrades(request);

    expect(request).toHaveBeenCalledWith(`/v1/dvp/trades?limit=${DVP_TRADES_PAGE_SIZE}`);
  });

  it("carries the API's message out on a failure", async () => {
    const result = await fetchDvpTrades(fail(503, { error: { message: "Upstream down." } }));

    expect(result).toEqual({ trades: [], error: "Upstream down." });
  });

  it("falls back to the status when the error body is unreadable", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    }) as never;

    expect((await fetchDvpTrades(request)).error).toContain("500");
  });

  it("survives a transport failure rather than throwing at the page", async () => {
    const request = vi.fn().mockRejectedValue(new Error("socket hang up")) as never;

    expect(await fetchDvpTrades(request)).toEqual({ trades: [], error: "socket hang up" });
  });

  it("treats a missing trades array as an empty list, not a failure", async () => {
    expect(await fetchDvpTrades(ok({ data: {} }))).toEqual({ trades: [], error: null });
  });
});

describe("fetchDvpTrade", () => {
  it("returns the trade and its status", async () => {
    const result = await fetchDvpTrade(ok({ data: { trade: { id: "dvp_1" } } }), "dvp_1");

    expect(result.trade).toEqual({ id: "dvp_1" });
    expect(result.status).toBe(200);
  });

  it("encodes the trade id into the path", async () => {
    const request = ok({ data: { trade: null } });

    await fetchDvpTrade(request, "dvp/1");

    expect(request).toHaveBeenCalledWith("/v1/dvp/trades/dvp%2F1");
  });

  it("carries the upstream status out on a failure", async () => {
    const result = await fetchDvpTrade(fail(404, { error: { message: "No such trade." } }), "x");

    expect(result).toEqual({ trade: null, error: "No such trade.", status: 404 });
  });

  // A transport failure never reached the API, so there is no status and it
  // must never be read as absence.
  it("reports no status at all when the request never landed", async () => {
    const request = vi.fn().mockRejectedValue(new Error("socket hang up")) as never;

    const result = await fetchDvpTrade(request, "x");

    expect(result.status).toBeNull();
    expect(isNotFound(result)).toBe(false);
  });
});

describe("isNotFound", () => {
  // Only a 404 means the trade is genuinely not there. Rendering a 500 or a
  // rate limit as "not found" tells someone their trade is gone.
  it("is true only for a 404", () => {
    expect(isNotFound({ status: 404 })).toBe(true);
    for (const status of [200, 401, 403, 429, 500, 503, null]) {
      expect(isNotFound({ status })).toBe(false);
    }
  });
});
