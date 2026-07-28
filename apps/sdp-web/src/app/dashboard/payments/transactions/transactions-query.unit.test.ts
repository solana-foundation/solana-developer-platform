import { describe, expect, it } from "vitest";
import {
  countActiveTransactionFilters,
  normalizeTransactionSearch,
  parseTransactionFilters,
  serializeTransactionFilters,
  toTransactionsApiQuery,
} from "./transactions-query";

describe("transaction filter query", () => {
  it("parses supported values and rejects malformed input", () => {
    expect(
      parseTransactionFilters({
        search: ["  xfr_42  ", "ignored"],
        status: "confirmed",
        direction: "sideways",
        type: "offramp",
        from: "2026-07-01",
        to: "not-a-date",
        page: "3",
        pageSize: "500",
        sortBy: "amount",
        sortDirection: "asc",
      })
    ).toMatchObject({
      search: "xfr_42",
      status: "confirmed",
      direction: undefined,
      type: "offramp",
      from: "2026-07-01",
      to: undefined,
      page: 3,
      pageSize: 100,
      sortBy: "amount",
      sortDirection: "asc",
    });
  });

  it("only activates meaningful searches of at least three characters", () => {
    expect(normalizeTransactionSearch(undefined)).toBeUndefined();
    expect(normalizeTransactionSearch("   ")).toBeUndefined();
    expect(normalizeTransactionSearch(" x ")).toBeUndefined();
    expect(normalizeTransactionSearch(" xy ")).toBeUndefined();
    expect(normalizeTransactionSearch(" xyz ")).toBe("xyz");

    const filters = parseTransactionFilters({
      search: "xy",
      snapshot: "2026-07-18T12:00:00.000Z",
    });
    expect(filters.search).toBeUndefined();
    expect(serializeTransactionFilters(filters).has("search")).toBe(false);
    expect(toTransactionsApiQuery({ ...filters, search: "xy" }).has("search")).toBe(false);
  });

  it("serializes only non-default URL filters and resets cleanly", () => {
    const filters = parseTransactionFilters({
      search: "alice",
      wallet: "wallet_1",
      status: "failed",
      sortDirection: "asc",
      page: "2",
      snapshot: "2026-07-18T12:00:00.000Z",
    });

    expect(serializeTransactionFilters(filters).toString()).toBe(
      "search=alice&status=failed&wallet=wallet_1&sortDirection=asc&snapshot=2026-07-18T12%3A00%3A00.000Z&page=2"
    );
    expect(countActiveTransactionFilters(filters)).toBe(2);
  });

  it("translates date boundaries and forces stable database pagination for the API", () => {
    const filters = parseTransactionFilters(
      {
        from: "2026-07-01",
        to: "2026-07-18",
        counterparty: "counterparty_1",
      },
      new Date("2026-07-18T12:00:00.000Z")
    );
    const query = toTransactionsApiQuery(filters);

    expect(query.get("includeObserved")).toBe("true");
    expect(query.get("counterpartyId")).toBe("counterparty_1");
    expect(query.get("from")).toBe("2026-07-01T00:00:00.000Z");
    expect(query.get("to")).toBe("2026-07-18T12:00:00.000Z");
  });

  it("includes observed deposits unless they are explicitly excluded", () => {
    // Home shows observed rows, so this table defaults to matching it.
    expect(parseTransactionFilters({}).includeObserved).toBe(true);
    expect(parseTransactionFilters({ includeObserved: "false" }).includeObserved).toBe(false);
    // Anything that is not exactly "false" leaves them on.
    expect(parseTransactionFilters({ includeObserved: "no" }).includeObserved).toBe(true);
  });

  it("keeps the default out of the URL and round-trips the exclusion", () => {
    const base = parseTransactionFilters({});
    expect(serializeTransactionFilters(base).has("includeObserved")).toBe(false);

    const excluded = serializeTransactionFilters({ ...base, includeObserved: false });
    expect(excluded.get("includeObserved")).toBe("false");
    expect(parseTransactionFilters(Object.fromEntries(excluded)).includeObserved).toBe(false);
  });

  it("counts the exclusion as an active filter only when switched off", () => {
    const base = parseTransactionFilters({});
    expect(countActiveTransactionFilters(base)).toBe(0);
    expect(countActiveTransactionFilters({ ...base, includeObserved: false })).toBe(1);
  });

  it("sends the exclusion through to the API query", () => {
    const filters = parseTransactionFilters({ includeObserved: "false" });
    expect(toTransactionsApiQuery(filters).get("includeObserved")).toBe("false");
  });
});
