import { describe, expect, it } from "vitest";
import {
  parseTransactionFilters,
  parseTransactionModule,
  serializeTransactionFilters,
  toTransactionsApiQuery,
} from "./transactions-query";

describe("transaction filter query", () => {
  it("parses valid fields independently", () => {
    expect(
      parseTransactionFilters({
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
      parseTransactionFilters({
        tab: "unknown",
        status: "complete",
        search: "xy",
        from: "not-a-date",
        to: "2026-07-18",
        cursor: "",
      })
    ).not.toThrow();
    expect(
      parseTransactionFilters({
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
    expect(parseTransactionModule("earn")).toBe("earn");
    expect(parseTransactionModule("all")).toBeUndefined();
    expect(parseTransactionModule(null)).toBeUndefined();
    expect(parseTransactionModule("unknown")).toBeUndefined();
    expect(parseTransactionFilters({ tab: "all" }).module).toBeUndefined();
  });

  it("serializes filters to tab and translates date boundaries for the API", () => {
    const filters = parseTransactionFilters({
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
