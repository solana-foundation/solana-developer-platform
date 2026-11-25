// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransactionFilters } from "./transactions-query";
import { useCursorPagination } from "./use-cursor-pagination";

const navigate = vi.fn<(next: TransactionFilters) => void>();

beforeEach(() => navigate.mockReset());

describe("useCursorPagination", () => {
  it("advances with the server cursor and remembers it for the way back", () => {
    const filters: TransactionFilters = { module: "earn", cursors: [] };
    const { result } = renderHook(() => useCursorPagination(filters, "cursor_2", navigate));

    expect(result.current.page).toBe(1);
    expect(result.current.pageCount).toBe(2);
    result.current.goToPage(2);
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      module: "earn",
      cursor: "cursor_2",
      cursors: ["cursor_2"],
    });
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
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      module: "earn",
      cursor: "cursor_2",
      cursors: ["cursor_2"],
    });
  });

  it("returns to the first page without a cursor", () => {
    const filters: TransactionFilters = {
      module: "earn",
      cursor: "cursor_2",
      cursors: ["cursor_2"],
    };
    const { result } = renderHook(() => useCursorPagination(filters, "cursor_3", navigate));

    result.current.goToPage(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      module: "earn",
      cursor: undefined,
      cursors: [],
    });
  });
});
