import { describe, expect, it } from "vitest";
import {
  countActiveTransactionFilters,
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

    expect(query.get("includeObserved")).toBe("false");
    expect(query.get("counterpartyId")).toBe("counterparty_1");
    expect(query.get("from")).toBe("2026-07-01T00:00:00.000Z");
    expect(query.get("to")).toBe("2026-07-18T12:00:00.000Z");
  });
});
