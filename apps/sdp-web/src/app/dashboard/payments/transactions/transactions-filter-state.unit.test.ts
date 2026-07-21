import { describe, expect, it } from "vitest";
import {
  reconcileDeferredFilterInput,
  resolveReturnedTransactionFilterSync,
  shouldApplyReturnedTransactionFilters,
} from "./transactions-filter-state";
import type { TransactionFilters } from "./transactions-query";

function filters(overrides: Partial<TransactionFilters> = {}): TransactionFilters {
  return {
    sortBy: "createdAt",
    sortDirection: "desc",
    snapshot: "2026-07-18T12:00:00.000Z",
    page: 1,
    pageSize: 25,
    ...overrides,
  };
}

describe("transaction filter response reconciliation", () => {
  it("rejects an older server response after a newer filter navigation was requested", () => {
    expect(
      shouldApplyReturnedTransactionFilters(
        filters({ search: "north" }),
        filters({ search: "northstar", snapshot: "2026-07-18T12:00:01.000Z" })
      )
    ).toBe(false);
  });

  it("keeps newer local typing when an earlier server value returns", () => {
    expect(reconcileDeferredFilterInput({ value: "northstar", dirty: true }, "north")).toEqual({
      value: "northstar",
      dirty: true,
    });
  });

  it("accepts an intentional same-path query clear and forces deferred inputs to reset", () => {
    expect(
      resolveReturnedTransactionFilterSync(
        filters({ search: undefined, snapshot: "2026-07-18T12:00:02.000Z" }),
        filters({ search: "northstar" }),
        { currentSearch: "" }
      )
    ).toEqual({ apply: true, forceDeferredInputs: true });
  });

  it("rejects a stale response when the current URL contains newer typing", () => {
    expect(
      resolveReturnedTransactionFilterSync(
        filters({ search: "north", snapshot: "2026-07-18T12:00:01.000Z" }),
        filters({ search: "northstar", snapshot: "2026-07-18T12:00:02.000Z" }),
        {
          currentSearch: "?search=northstar&snapshot=2026-07-18T12%3A00%3A02.000Z",
        }
      )
    ).toEqual({ apply: false, forceDeferredInputs: false });
  });

  it("accepts a matching current URL without forcing newer deferred typing", () => {
    expect(
      resolveReturnedTransactionFilterSync(filters({ search: "north" }), filters(), {
        currentSearch: "?search=north&snapshot=2026-07-18T12%3A00%3A00.000Z",
      })
    ).toEqual({ apply: true, forceDeferredInputs: true });
    expect(
      resolveReturnedTransactionFilterSync(
        filters({ search: "north" }),
        filters({ search: "north" }),
        {
          currentSearch: "?search=north&snapshot=2026-07-18T12%3A00%3A00.000Z",
        }
      )
    ).toEqual({ apply: true, forceDeferredInputs: false });
  });

  it("settles matching local input and still lets browser history force a sync", () => {
    expect(
      reconcileDeferredFilterInput({ value: " northstar ", dirty: true }, "northstar")
    ).toEqual({ value: "northstar", dirty: false });
    expect(
      reconcileDeferredFilterInput({ value: "new typing", dirty: true }, "history value", true)
    ).toEqual({ value: "history value", dirty: false });
    expect(
      shouldApplyReturnedTransactionFilters(
        filters({ search: "history value" }),
        filters({ search: "new typing" }),
        true
      )
    ).toBe(true);
  });

  it("does not let a stale response consume a browser-history sync for a newer URL", () => {
    expect(
      resolveReturnedTransactionFilterSync(
        filters({ search: "old query" }),
        filters({ search: "old query" }),
        {
          browserNavigation: true,
          currentSearch: "?search=history-query",
        }
      )
    ).toEqual({ apply: false, forceDeferredInputs: false });
  });
});
