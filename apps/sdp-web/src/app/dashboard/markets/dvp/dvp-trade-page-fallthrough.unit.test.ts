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
  // THE regression. Null trade, null error, 200 status.
  it("a 200 with no trade in it is not an absence", async () => {
    const result = await fetchDvpTrade(respond(200, { data: {} }), "dvp_1");

    expect(result.trade).toBeNull();
    expect(result.error).toBeNull();
    // Keying the branch off the message would send this to notFound().
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
