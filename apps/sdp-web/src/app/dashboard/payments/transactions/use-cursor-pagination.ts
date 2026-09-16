"use client";

import type { TransactionFilters } from "./transactions-query";

export function useCursorPagination(
  filters: TransactionFilters,
  nextCursor: string | null,
  navigate: (next: TransactionFilters) => void
) {
  const page = filters.cursors.length + 1;
  return {
    page,
    pageCount: nextCursor === null ? page : page + 1,
    goToPage(target: number) {
      if (target === page + 1 && nextCursor !== null) {
        navigate({ ...filters, cursor: nextCursor, cursors: [...filters.cursors, nextCursor] });
        return;
      }
      if (target === page - 1) {
        const cursors = filters.cursors.slice(0, -1);
        const cursor = cursors.length === 0 ? undefined : cursors[cursors.length - 1];
        navigate({ ...filters, cursor, cursors });
      }
    },
  };
}
