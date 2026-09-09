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

  /**
   * Greptile's blocking finding on this PR: a 200 whose body carries a TRUTHY
   * but partial trade passed the null check, entered the success branch, and
   * threw when the workspace dereferenced its missing legs. A truthy object is
   * not a renderable one.
   */
  it.each([
    ["an empty object", {}],
    ["no legs at all", { id: "dvp_1", status: "created" }],
    ["a null legs bag", { id: "dvp_1", status: "created", legs: null }],
    ["only one leg", { id: "dvp_1", status: "created", legs: { a: {} } }],
    ["a null leg", { id: "dvp_1", status: "created", legs: { a: {}, b: null } }],
    ["no id", { status: "created", legs: { a: {}, b: {} } }],
  ])("refuses a 200 carrying %s rather than rendering it", async (_label, trade) => {
    const result = await fetchDvpTrade(respond(200, { data: { trade } }), "dvp_1");

    expect(result.trade).toBeNull();
    // Retryable, not absent: the trade may well exist and hold both legs.
    expect(isNotFound(result)).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("renders a 200 that does carry both legs", async () => {
    const trade = { id: "dvp_1", status: "created", legs: { a: {}, b: {} } };
    const result = await fetchDvpTrade(respond(200, { data: { trade } }), "dvp_1");

    expect(result.trade).toEqual(trade);
    expect(result.error).toBeNull();
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

  /**
   * The same failure one step further in, across every partial shape a 200 can
   * carry. A truthy object is not a renderable one, and each of these used to
   * reach the workspace and throw on a missing leg.
   */
  it.each([
    ["no legs at all", { id: "dvp_1", status: "created" }],
    ["a null legs bag", { id: "dvp_1", status: "created", legs: null }],
    ["only one leg", { id: "dvp_1", status: "created", legs: { a: {} } }],
    ["a null leg", { id: "dvp_1", status: "created", legs: { a: {}, b: null } }],
    ["no id", { status: "created", legs: { a: {}, b: {} } }],
  ])("refuses a 200 carrying %s", async (_label, trade) => {
    const result = await fetchDvpTrade(respond(200, { data: { trade } }), "dvp_1");

    expect(result.trade).toBeNull();
    expect(isNotFound(result)).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("renders a 200 that does carry both legs", async () => {
    const trade = { id: "dvp_1", status: "created", legs: { a: {}, b: {} } };
    const result = await fetchDvpTrade(respond(200, { data: { trade } }), "dvp_1");

    expect(result.trade).toEqual(trade);
    expect(result.error).toBeNull();
  });
});
