import { UNIFIED_TRANSACTION_MODULES } from "@sdp/types/unified-transactions";
import { describe, expect, it } from "vitest";
import { transactionsApiQuery } from "./transactions-page.data";
import {
  parseTransactionFilters,
  serializeTransactionFilters,
  toTransactionsApiQuery,
} from "./transactions-query";

const ALL = UNIFIED_TRANSACTION_MODULES;

describe("transaction filter query", () => {
  it("parses valid fields independently", () => {
    expect(
      parseTransactionFilters(
        {
          module: "payments",
          status: "succeeded",
          counterpartyId: "  cpty_42  ",
          search: ["  xfr_42  ", "ignored"],
          from: "2026-07-01",
          to: "2026-07-18",
          cursors: "first,second",
        },
        ALL
      )
    ).toEqual({
      module: "payments",
      status: "succeeded",
      counterpartyId: "cpty_42",
      search: "xfr_42",
      from: "2026-07-01",
      to: "2026-07-18",
      cursors: ["first", "second"],
    });
  });

  it("treats every malformed URL field as absent without dropping valid fields", () => {
    expect(
      parseTransactionFilters(
        {
          module: "unknown",
          status: "complete",
          search: "xy",
          from: "not-a-date",
          to: "2026-07-18",
          cursor: "",
        },
        ALL
      )
    ).toEqual({ to: "2026-07-18", cursors: [] });
  });

  it("keeps a supported page size and drops the default or an unsupported one", () => {
    expect(transactionsApiQuery(parseTransactionFilters({ pageSize: "50" }, ALL))).toBe("limit=50");
    expect(parseTransactionFilters({ pageSize: "25" }, ALL)).not.toHaveProperty("pageSize");
    expect(parseTransactionFilters({ pageSize: "7" }, ALL)).not.toHaveProperty("pageSize");
    expect(
      serializeTransactionFilters(parseTransactionFilters({ pageSize: "100" }, ALL)).toString()
    ).toBe("pageSize=100");
  });

  it("serializes filters to module and translates date boundaries for the API", () => {
    const filters = parseTransactionFilters(
      {
        module: "earn",
        counterpartyId: "cpty_42",
        from: "2026-07-01",
        to: "2026-07-18",
        cursors: "first",
        cursor: "second",
      },
      ALL
    );

    expect(serializeTransactionFilters(filters).toString()).toBe(
      "module=earn&counterpartyId=cpty_42&from=2026-07-01&to=2026-07-18&cursor=second&cursors=first"
    );
    expect(toTransactionsApiQuery(filters, 100).toString()).toBe(
      "limit=100&module=earn&counterpartyId=cpty_42&createdAtFrom=2026-07-01T00%3A00%3A00.000Z&createdAtTo=2026-07-18T23%3A59%3A59.999Z&cursor=second"
    );
  });

  it("drops a module the channel leaves out, with its kind and its cursor", () => {
    expect(
      parseTransactionFilters(
        { module: "issuance", kind: "mint", cursor: "c2", cursors: "c1", status: "succeeded" },
        ["payments"]
      )
    ).toEqual({ status: "succeeded", cursors: [] });
  });

  it("drops a kind that arrives without its module", () => {
    expect(parseTransactionFilters({ kind: "deposit" }, ALL)).toEqual({ cursors: [] });
  });
});
