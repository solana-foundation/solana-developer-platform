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

  it("maps the module param: a module id selects it, all and unknown mean the default", () => {
    expect(parseTransactionModule("earn")).toBe("earn");
    expect(parseTransactionModule("all")).toBeUndefined();
    expect(parseTransactionModule(null)).toBeUndefined();
    expect(parseTransactionModule("unknown")).toBeUndefined();
    expect(parseTransactionFilters({ tab: "all" }).module).toBeUndefined();
  });

  it("reads the module from ?module=, falling back to the legacy ?tab=", () => {
    expect(parseTransactionFilters({ module: "dvp", tab: "earn" }).module).toBe("dvp");
    expect(parseTransactionFilters({ tab: "earn" }).module).toBe("earn");
  });

  it("keeps a supported page size and drops the default or an unsupported one", () => {
    expect(parseTransactionFilters({ pageSize: "50" }).pageSize).toBe(50);
    expect(parseTransactionFilters({ pageSize: "25" })).not.toHaveProperty("pageSize");
    expect(parseTransactionFilters({ pageSize: "7" })).not.toHaveProperty("pageSize");
    expect(
      serializeTransactionFilters(parseTransactionFilters({ pageSize: "100" })).toString()
    ).toBe("pageSize=100");
  });

  it("serializes filters to module and translates date boundaries for the API", () => {
    const filters = parseTransactionFilters({
      module: "earn",
      counterpartyId: "cpty_42",
      from: "2026-07-01",
      to: "2026-07-18",
      cursors: "first",
      cursor: "second",
    });

    expect(serializeTransactionFilters(filters).toString()).toBe(
      "module=earn&counterpartyId=cpty_42&from=2026-07-01&to=2026-07-18&cursor=second&cursors=first"
    );
    expect(toTransactionsApiQuery(filters, 100).toString()).toBe(
      "limit=100&module=earn&counterpartyId=cpty_42&createdAtFrom=2026-07-01T00%3A00%3A00.000Z&createdAtTo=2026-07-18T23%3A59%3A59.999Z&cursor=second"
    );
  });
});
