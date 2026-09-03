/**
 * The condition the detail page routes on.
 *
 * A trade that is absent and one that could not be read take opposite paths:
 * 404 renders Next's not-found, everything else renders a retryable error. The
 * case that broke this was a 200 whose body carried no trade, because it
 * produces a null trade with NO error message, and a page that keyed off the
 * message fell through to "not found" for it.
 */

import { describe, expect, it, vi } from "vitest";
import { fetchDvpTrade, isNotFound } from "./dvp-trades.data";

function respond(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as never;
}

describe("detail page routing", () => {
  // THE regression: a 200 carrying no trade must not read as "not found".
  //
  // The guard is that `isNotFound` keys off the STATUS. It used to key off the
  // message, and this case has no upstream message — so it fell through to
  // notFound() and told someone their trade was gone while it sat in escrow
  // holding both parties' money.
  //
  // The error is no longer null here, and that is the improvement rather than a
  // weakening: the case is now described instead of reaching the error view
  // with nothing to say. What must not change is the status check below.
  it("a 200 with no trade in it is not an absence", async () => {
    const result = await fetchDvpTrade(respond(200, { data: {} }), "dvp_1");

    expect(result.trade).toBeNull();
    expect(result.status).toBe(200);
    expect(isNotFound(result)).toBe(false);
  });

  // Same shape of failure, one step further in: the body HAS a trade, and it is
  // not one this UI can render. It must reach the same retryable error rather
  // than a render exception.
  it("a 200 with an unusable trade in it is not an absence either", async () => {
    const result = await fetchDvpTrade(respond(200, { data: { trade: {} } }), "dvp_1");

    expect(result.trade).toBeNull();
    expect(result.error).toBeTruthy();
    expect(isNotFound(result)).toBe(false);
  });

  it("a genuine 404 is an absence", async () => {
    const result = await fetchDvpTrade(respond(404, {}), "dvp_1");

    expect(isNotFound(result)).toBe(true);
  });

  it("a 500 is not an absence", async () => {
    const result = await fetchDvpTrade(respond(500, {}), "dvp_1");

    expect(isNotFound(result)).toBe(false);
    expect(result.error).toContain("500");
  });

  it("a dropped connection is not an absence", async () => {
    const request = vi.fn().mockRejectedValue(new Error("socket hang up")) as never;

    expect(isNotFound(await fetchDvpTrade(request, "dvp_1"))).toBe(false);
  });
});
