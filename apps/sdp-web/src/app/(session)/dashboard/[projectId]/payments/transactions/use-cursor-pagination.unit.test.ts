// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransactionFilters } from "./transactions-query";
import { useCursorPagination } from "./use-cursor-pagination";

const navigate = vi.fn<(next: TransactionFilters) => void>();

function lastNavigation(): TransactionFilters {
  const [next] = navigate.mock.lastCall as [TransactionFilters];
  return next;
}

beforeEach(() => navigate.mockReset());

describe("useCursorPagination", () => {
  it("advances with the server cursor and remembers it for the way back", () => {
    const filters: TransactionFilters = { module: "earn", cursors: [] };
    const { result } = renderHook(() => useCursorPagination(filters, "cursor_2", navigate));

    expect(result.current.page).toBe(1);
    expect(result.current.pageCount).toBe(2);
    result.current.goToPage(2);
    expect(lastNavigation().cursor).toBe("cursor_2");
    expect(lastNavigation().cursors).toEqual(["cursor_2"]);
  });

  it("returns to the previous page by popping the cursor history", () => {
    const filters: TransactionFilters = {
      module: "earn",
      cursor: "cursor_3",
      cursors: ["cursor_2", "cursor_3"],
    };
    const { result } = renderHook(() => useCursorPagination(filters, null, navigate));

    expect(result.current.page).toBe(3);
    expect(result.current.pageCount).toBe(3);
    result.current.goToPage(2);
    expect(lastNavigation().cursor).toBe("cursor_2");
    expect(lastNavigation().cursors).toEqual(["cursor_2"]);
  });
});
