import { badRequest } from "@/lib/errors";

// Strict positive-integer query param: absent → fallback; anything that isn't an
// integer >= 1 (0, negatives, floats, garbage) → 400. Prevents NaN/negative values
// from reaching SQL LIMIT/OFFSET.
export function parsePositiveIntegerQuery(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest(`Invalid ${name} query parameter`);
  }

  return parsed;
}

// The common page/pageSize pair with a hard pageSize cap.
export function parsePagination(
  query: { page?: string; pageSize?: string },
  defaults: { pageSize: number; maxPageSize: number }
): { page: number; pageSize: number; offset: number } {
  const page = parsePositiveIntegerQuery(query.page, 1, "page");
  const pageSize = Math.min(
    parsePositiveIntegerQuery(query.pageSize, defaults.pageSize, "pageSize"),
    defaults.maxPageSize
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}
