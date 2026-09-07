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
  // THE regression. A 200 carrying no trade must not read as absence.
  it("a 200 with no trade in it is not an absence", async () => {
    const result = await fetchDvpTrade(respond(200, { data: {} }), "dvp_1");

    expect(result.trade).toBeNull();
    // Keying the branch off the message would send this to notFound().
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
});
