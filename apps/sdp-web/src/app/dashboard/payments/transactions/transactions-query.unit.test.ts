import { UNIFIED_TRANSACTION_MODULES } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  parseTransactionFilters,
  parseTransactionModule,
  serializeTransactionFilters,
  toTransactionsApiQuery,
} from "./transactions-query";

const parseAll = (searchParams: Parameters<typeof parseTransactionFilters>[0]) =>
  parseTransactionFilters(searchParams, UNIFIED_TRANSACTION_MODULES);

describe("transaction filter query", () => {
  it("parses valid fields independently", () => {
    expect(
      parseAll({
        tab: "payments",
        status: "succeeded",
        counterpartyId: "  cpty_42  ",
        search: ["  xfr_42  ", "ignored"],
        from: "2026-07-01",
        to: "2026-07-18",
        cursors: "first,second",
      })
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
    expect(() =>
      parseAll({
        tab: "unknown",
        status: "complete",
        search: "xy",
        from: "not-a-date",
        to: "2026-07-18",
        cursor: "",
      })
    ).not.toThrow();
    expect(
      parseAll({
        tab: "unknown",
        status: "complete",
        search: "xy",
        from: "not-a-date",
        to: "2026-07-18",
        cursor: "",
      })
    ).toEqual({ to: "2026-07-18", cursors: [] });
  });

  it("maps the shared tab param: a module id selects it, all and unknown mean the default", () => {
    expect(parseTransactionModule("earn", UNIFIED_TRANSACTION_MODULES)).toBe("earn");
    expect(parseTransactionModule("all", UNIFIED_TRANSACTION_MODULES)).toBeUndefined();
    expect(parseTransactionModule(null, UNIFIED_TRANSACTION_MODULES)).toBeUndefined();
    expect(parseTransactionModule("unknown", UNIFIED_TRANSACTION_MODULES)).toBeUndefined();
    expect(parseAll({ tab: "all" }).module).toBeUndefined();
  });

  it("treats a module the dashboard does not show as the default tab", () => {
    expect(parseTransactionModule("issuance", ["payments"])).toBeUndefined();
    expect(parseTransactionFilters({ tab: "issuance" }, ["payments"]).module).toBeUndefined();
    expect(parseTransactionFilters({ tab: "payments" }, ["payments"]).module).toBe("payments");
  });

  it("serializes filters to tab and translates date boundaries for the API", () => {
    const filters = parseAll({
      tab: "earn",
      counterpartyId: "cpty_42",
      from: "2026-07-01",
      to: "2026-07-18",
      cursors: "first",
      cursor: "second",
    });

    expect(serializeTransactionFilters(filters).toString()).toBe(
      "tab=earn&counterpartyId=cpty_42&from=2026-07-01&to=2026-07-18&cursor=second&cursors=first"
    );
    expect(toTransactionsApiQuery(filters, 100).toString()).toBe(
      "limit=100&module=earn&counterpartyId=cpty_42&createdAtFrom=2026-07-01T00%3A00%3A00.000Z&createdAtTo=2026-07-18T23%3A59%3A59.999Z&cursor=second"
    );
  });
});
