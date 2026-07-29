// The asset list's search/filter/sort/page state, in one place.
//
// One module owns three translations of the same state so they can't drift:
//   • URL  ⇄ state — shareable, bookmarkable, survives a reload (parse/toUrl)
//   • state → SDP API query — what /v1/issuance/tokens actually accepts
// The workspace holds this state, the BFF route and the RSC page both parse it
// from an incoming request, and only the two server-side callers translate it to
// API params (the client never computes a timestamp, so its SWR keys stay stable
// and cache hits survive the clock moving).
//
// Filtering is entirely server-side: nothing here narrows a token array.

// Mirrors DeploymentStatus in issuance-token-fields — "active" no longer covers
// paused tokens, so paused needs its own option or those tokens become
// unreachable from the filter.
export type IssuanceStatusFilter = "all" | "draft" | "active" | "paused";
export type IssuanceDateFilter = "all" | "7d" | "30d" | "12m";
export type IssuanceSortOption = "newest" | "oldest" | "name-asc" | "name-desc";

/** The narrowing filters plus sort — everything the filter popover owns. */
export interface IssuanceFilterState {
  status: IssuanceStatusFilter;
  template: string;
  date: IssuanceDateFilter;
  sort: IssuanceSortOption;
}

export interface IssuanceListQuery extends IssuanceFilterState {
  /** Free-text needle; "" means no search. */
  search: string;
  page: number;
  pageSize: number;
}

// 24 divides evenly into the grid's 2- and 3-column layouts, so the last row is
// never a lone card.
export const ISSUANCE_DEFAULT_PAGE_SIZE = 24;
// Bounds what a hand-edited URL can ask the API for. The API caps at 100 too;
// clamping here keeps the client's own page math honest either way.
export const ISSUANCE_MAX_PAGE_SIZE = 100;
export const ISSUANCE_MAX_SEARCH_LENGTH = 100;
// Matches the API's page bound, so a hand-edited page number is clamped here
// rather than round-tripping into a 400.
export const ISSUANCE_MAX_PAGE = 1_000_000;

export const DEFAULT_ISSUANCE_FILTERS: IssuanceFilterState = {
  status: "all",
  template: "all",
  date: "all",
  sort: "newest",
};

export const DEFAULT_ISSUANCE_LIST_QUERY: IssuanceListQuery = {
  ...DEFAULT_ISSUANCE_FILTERS,
  search: "",
  page: 1,
  pageSize: ISSUANCE_DEFAULT_PAGE_SIZE,
};

const DATE_WINDOW_DAYS: Record<Exclude<IssuanceDateFilter, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "12m": 365,
};

const SORT_TO_API: Record<IssuanceSortOption, { sortBy: string; sortDirection: string }> = {
  newest: { sortBy: "createdAt", sortDirection: "desc" },
  oldest: { sortBy: "createdAt", sortDirection: "asc" },
  "name-asc": { sortBy: "name", sortDirection: "asc" },
  "name-desc": { sortBy: "name", sortDirection: "desc" },
};

const STATUS_VALUES: IssuanceStatusFilter[] = ["all", "draft", "active", "paused"];
const DATE_VALUES: IssuanceDateFilter[] = ["all", "7d", "30d", "12m"];
const SORT_VALUES: IssuanceSortOption[] = ["newest", "oldest", "name-asc", "name-desc"];

/** Accepts both an RSC `searchParams` object and a `URLSearchParams`. */
export type IssuanceQuerySource =
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | undefined;

function readParam(source: IssuanceQuerySource, key: string): string | undefined {
  if (!source) {
    return undefined;
  }
  const raw = source instanceof URLSearchParams ? source.get(key) : source[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value : undefined;
}

function readEnum<T extends string>(
  source: IssuanceQuerySource,
  key: string,
  allowed: T[],
  fallback: T
): T {
  const value = readParam(source, key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function readPositiveInt(
  source: IssuanceQuerySource,
  key: string,
  fallback: number,
  maximum: number
): number {
  const parsed = Number(readParam(source, key));
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

/**
 * Reads list state off a URL. Never throws and never rejects: anything
 * unrecognised falls back to its default, so a hand-edited or stale link
 * degrades to a sane list instead of an error page.
 */
export function parseIssuanceListQuery(source: IssuanceQuerySource): IssuanceListQuery {
  return {
    search: (readParam(source, "search") ?? "").trim().slice(0, ISSUANCE_MAX_SEARCH_LENGTH),
    status: readEnum(source, "status", STATUS_VALUES, "all"),
    // Template ids are open-ended (older tokens carry legacy ids), so this is a
    // length-bounded passthrough rather than an enum. The API matches it exactly
    // — an unknown value yields an empty page, not an error.
    template: (readParam(source, "template") ?? "all").trim().slice(0, 64) || "all",
    date: readEnum(source, "date", DATE_VALUES, "all"),
    sort: readEnum(source, "sort", SORT_VALUES, "newest"),
    page: readPositiveInt(source, "page", 1, ISSUANCE_MAX_PAGE),
    pageSize: readPositiveInt(
      source,
      "pageSize",
      ISSUANCE_DEFAULT_PAGE_SIZE,
      ISSUANCE_MAX_PAGE_SIZE
    ),
  };
}

/**
 * State → URL params, defaults omitted, so an untouched list keeps a clean
 * `/dashboard/issuance` and a shared link carries only what was actually chosen.
 * `null` clears a param (what `replaceSearchParams` expects).
 */
export function toIssuanceListUrlParams(query: IssuanceListQuery): Record<string, string | null> {
  return {
    search: query.search || null,
    status: query.status === "all" ? null : query.status,
    template: query.template === "all" ? null : query.template,
    date: query.date === "all" ? null : query.date,
    sort: query.sort === DEFAULT_ISSUANCE_LIST_QUERY.sort ? null : query.sort,
    page: query.page > 1 ? String(query.page) : null,
    pageSize: query.pageSize === ISSUANCE_DEFAULT_PAGE_SIZE ? null : String(query.pageSize),
  };
}

/** State → the query string the BFF route expects (same vocabulary as the URL). */
export function toIssuanceListRequestParams(query: IssuanceListQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(toIssuanceListUrlParams(query))) {
    if (value !== null) {
      params.set(key, value);
    }
  }
  return params;
}

/**
 * State → `/v1/issuance/tokens` params. Server-side only: the relative date
 * window resolves against `nowMs` here, at request time, so the client's cache
 * keys never carry a timestamp.
 */
export function toIssuanceTokensApiParams(
  query: IssuanceListQuery,
  nowMs: number
): URLSearchParams {
  const { sortBy, sortDirection } = SORT_TO_API[query.sort] ?? SORT_TO_API.newest;
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
    sortBy,
    sortDirection,
  });

  if (query.search) {
    params.set("search", query.search);
  }
  // The dashboard's status filter is the *derived* lifecycle state (a token is a
  // draft until it has a mint), not the stored column.
  if (query.status !== "all") {
    params.set("deploymentStatus", query.status);
  }
  if (query.template !== "all") {
    params.set("template", query.template);
  }
  if (query.date !== "all") {
    const windowMs = DATE_WINDOW_DAYS[query.date] * 86_400_000;
    params.set("createdAfter", new Date(nowMs - windowMs).toISOString());
  }

  return params;
}

/**
 * Count only the narrowing filters (status/template/date) — sort always has a
 * value, so it doesn't count toward "active filters". Search is shown in its own
 * input, so it isn't counted on the filter badge either.
 */
export function countActiveIssuanceFilters(filters: IssuanceFilterState): number {
  let count = 0;
  if (filters.status !== "all") count += 1;
  if (filters.template !== "all") count += 1;
  if (filters.date !== "all") count += 1;
  return count;
}

/** Is anything narrowing the list right now (search included)? */
export function hasActiveIssuanceListFilters(query: IssuanceListQuery): boolean {
  return Boolean(query.search) || countActiveIssuanceFilters(query) > 0;
}

/**
 * Identifies one result set — everything about a query except which page of it.
 * Two states sharing this key are pages of the same list, so page numbers are
 * comparable between them; once the key changes, any page fetched under the old
 * one describes a different list.
 */
export function getIssuanceListResultSetKey(query: IssuanceListQuery): string {
  return toIssuanceListRequestParams({ ...query, page: 1 }).toString();
}

/** Do two states describe the same request? Used to reuse the server's first page. */
export function isSameIssuanceListQuery(
  left: IssuanceListQuery,
  right: IssuanceListQuery
): boolean {
  return (
    left.search === right.search &&
    left.status === right.status &&
    left.template === right.template &&
    left.date === right.date &&
    left.sort === right.sort &&
    left.page === right.page &&
    left.pageSize === right.pageSize
  );
}
