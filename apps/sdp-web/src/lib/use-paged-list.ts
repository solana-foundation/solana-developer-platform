"use client";

import { useState } from "react";

/**
 * Pages a list held in memory: the current page, how many there are, and the rows to show. The
 * page is clamped to the list, so a list that shrinks under it (a search, a refresh) never leaves
 * it on a page past the end.
 *
 * @param items - The whole list, already filtered.
 * @param pageSize - Rows per page.
 * @returns The page state and the visible rows; `reset` goes back to the first page.
 */
export function usePagedList<T>(items: readonly T[], pageSize: number) {
  const [requestedPage, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const visible = items.slice((page - 1) * pageSize, page * pageSize);
  return { page, pageCount, visible, setPage, reset: () => setPage(1) };
}
