// Shared page math for the token workspace's paged lists (transactions,
// activity, control list). Keeps the three surfaces reporting identical
// "start–end of total" ranges and page counts.

export interface PageSummary {
  /** Always ≥ 1 so an empty list still reports "Page 1 of 1". */
  pageCount: number;
  /** 1-based index of the first row on this page; 0 when there are none. */
  start: number;
  /** 1-based index of the last row on this page; 0 when there are none. */
  end: number;
}

/** Always ≥ 1 so an empty list still reports "Page 1 of 1". */
export function getPageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function getPageSummary({
  page,
  pageSize,
  total,
  shown,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** Rows actually rendered — the last page is usually shorter than pageSize. */
  shown: number;
}): PageSummary {
  const pageCount = getPageCount(total, pageSize);
  if (total === 0 || shown === 0) {
    return { pageCount, start: 0, end: 0 };
  }

  const offset = (page - 1) * pageSize;
  return { pageCount, start: offset + 1, end: offset + shown };
}
