import { describe, expect, it } from "vitest";
import {
  countActiveTransactionFilters,
  hasRemovedTransactionWalletFilter,
  normalizeTransactionSearch,
  parseTransactionFilters,
  serializeTransactionFilters,
  toTransactionsApiQuery,
} from "./transactions-query";

describe("transaction filter query", () => {
  it.each([{ wallet: "wal_legacy" }, { walletAddress: "" }])(
    "detects removed wallet filters before they can broaden results: %j",
    (searchParams) => {
      expect(hasRemovedTransactionWalletFilter(searchParams)).toBe(true);
    }
  );

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
      custodyWalletId: "cwlt_1",
      status: "failed",
      sortDirection: "asc",
      page: "2",
      snapshot: "2026-07-18T12:00:00.000Z",
    });

    expect(serializeTransactionFilters(filters).toString()).toBe(
      "search=alice&status=failed&custodyWalletId=cwlt_1&sortDirection=asc&snapshot=2026-07-18T12%3A00%3A00.000Z&page=2"
    );
    expect(countActiveTransactionFilters(filters)).toBe(2);
  });

  it("translates date boundaries and forces stable database pagination for the API", () => {
    const filters = parseTransactionFilters(
      {
        from: "2026-07-01",
        to: "2026-07-18",
        counterparty: "cpty_1",
      },
      new Date("2026-07-18T12:00:00.000Z")
    );
    const query = toTransactionsApiQuery(filters);

    expect(query.get("includeObserved")).toBe("false");
    expect(query.get("counterpartyId")).toBe("cpty_1");
    expect(query.get("from")).toBe("2026-07-01T00:00:00.000Z");
    expect(query.get("to")).toBe("2026-07-18T12:00:00.000Z");
  });

  it("excludes observed deposits unless they are explicitly included", () => {
    expect(parseTransactionFilters({}).includeObserved).toBe(false);
    expect(parseTransactionFilters({ includeObserved: "true" }).includeObserved).toBe(false);
    expect(
      parseTransactionFilters({ custodyWalletId: "cwlt_1", includeObserved: "true" })
        .includeObserved
    ).toBe(true);
    expect(parseTransactionFilters({ includeObserved: "false" }).includeObserved).toBe(false);
    expect(parseTransactionFilters({ includeObserved: "no" }).includeObserved).toBe(false);
  });

  it("keeps the default out of the URL and round-trips the opt-in", () => {
    const base = parseTransactionFilters({});
    expect(serializeTransactionFilters(base).has("includeObserved")).toBe(false);

    expect(
      serializeTransactionFilters({ ...base, includeObserved: true }).has("includeObserved")
    ).toBe(false);

    const included = serializeTransactionFilters({
      ...base,
      custodyWalletId: "cwlt_1",
      includeObserved: true,
    });
    expect(included.get("includeObserved")).toBe("true");
    expect(parseTransactionFilters(Object.fromEntries(included)).includeObserved).toBe(true);
  });

  it("counts the observed opt-in as an active filter", () => {
    const base = parseTransactionFilters({});
    expect(countActiveTransactionFilters(base)).toBe(0);
    expect(countActiveTransactionFilters({ ...base, includeObserved: true })).toBe(0);
    expect(
      countActiveTransactionFilters({
        ...base,
        custodyWalletId: "cwlt_1",
        includeObserved: true,
      })
    ).toBe(2);
  });

  it("never sends observed history without an exact wallet", () => {
    const filters = { ...parseTransactionFilters({}), includeObserved: true };

    expect(toTransactionsApiQuery(filters).get("includeObserved")).toBe("false");
  });

  it("sends the exact wallet filter and observed opt-in through to the API query", () => {
    const filters = parseTransactionFilters({
      custodyWalletId: "cwlt_1",
      includeObserved: "true",
    });
    const query = toTransactionsApiQuery(filters);
    expect(query.get("custodyWalletId")).toBe("cwlt_1");
    expect(query.has("wallet")).toBe(false);
    expect(query.get("includeObserved")).toBe("true");
  });
});
