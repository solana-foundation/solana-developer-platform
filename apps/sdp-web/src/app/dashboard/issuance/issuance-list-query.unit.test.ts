import { describe, expect, it } from "vitest";
import {
  countActiveIssuanceFilters,
  DEFAULT_ISSUANCE_LIST_QUERY,
  getIssuanceListResultSetKey,
  hasActiveIssuanceListFilters,
  ISSUANCE_DEFAULT_PAGE_SIZE,
  ISSUANCE_MAX_PAGE,
  ISSUANCE_MAX_PAGE_SIZE,
  type IssuanceListQuery,
  isSameIssuanceListQuery,
  parseIssuanceListQuery,
  toIssuanceListRequestParams,
  toIssuanceListUrlParams,
  toIssuanceTokensApiParams,
} from "./issuance-list-query";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");

function query(changes: Partial<IssuanceListQuery> = {}): IssuanceListQuery {
  return { ...DEFAULT_ISSUANCE_LIST_QUERY, ...changes };
}

function apiParams(changes: Partial<IssuanceListQuery> = {}): Record<string, string> {
  return Object.fromEntries(toIssuanceTokensApiParams(query(changes), NOW));
}

describe("parseIssuanceListQuery", () => {
  it("defaults everything when nothing is supplied", () => {
    expect(parseIssuanceListQuery(undefined)).toEqual(DEFAULT_ISSUANCE_LIST_QUERY);
    expect(parseIssuanceListQuery({})).toEqual(DEFAULT_ISSUANCE_LIST_QUERY);
  });

  it("reads state from an RSC searchParams object", () => {
    expect(
      parseIssuanceListQuery({
        search: "  usdc  ",
        status: "paused",
        template: "stablecoin",
        date: "30d",
        sort: "name-asc",
        page: "3",
        pageSize: "48",
      })
    ).toEqual({
      search: "usdc",
      status: "paused",
      template: "stablecoin",
      date: "30d",
      sort: "name-asc",
      page: 3,
      pageSize: 48,
    });
  });

  it("reads state from URLSearchParams and takes the first repeated value", () => {
    const parsed = parseIssuanceListQuery(new URLSearchParams("status=draft&status=active&page=2"));
    expect(parsed.status).toBe("draft");
    expect(parsed.page).toBe(2);
  });

  it("falls back to defaults for unrecognised values instead of throwing", () => {
    const parsed = parseIssuanceListQuery({
      status: "deleted",
      date: "forever",
      sort: "supply",
      page: "-4",
      pageSize: "0",
    });
    expect(parsed).toEqual(DEFAULT_ISSUANCE_LIST_QUERY);
  });

  it("clamps pageSize and page to their maximums and bounds search length", () => {
    expect(parseIssuanceListQuery({ pageSize: "5000" }).pageSize).toBe(ISSUANCE_MAX_PAGE_SIZE);
    // Deep-offset guard: matches the API's bound, so a crafted page number is
    // clamped client-side instead of coming back as a 400.
    expect(parseIssuanceListQuery({ page: "9007199254740991" }).page).toBe(ISSUANCE_MAX_PAGE);
    expect(parseIssuanceListQuery({ search: "x".repeat(500) }).search).toHaveLength(100);
  });

  it("treats a blank template as no filter", () => {
    expect(parseIssuanceListQuery({ template: "   " }).template).toBe("all");
  });
});

describe("toIssuanceTokensApiParams", () => {
  it("sends page, size and the default sort with no filters", () => {
    expect(apiParams()).toEqual({
      page: "1",
      pageSize: String(ISSUANCE_DEFAULT_PAGE_SIZE),
      sortBy: "createdAt",
      sortDirection: "desc",
    });
  });

  it("maps each sort option to a whitelisted key and direction", () => {
    expect(apiParams({ sort: "oldest" })).toMatchObject({
      sortBy: "createdAt",
      sortDirection: "asc",
    });
    expect(apiParams({ sort: "name-asc" })).toMatchObject({
      sortBy: "name",
      sortDirection: "asc",
    });
    expect(apiParams({ sort: "name-desc" })).toMatchObject({
      sortBy: "name",
      sortDirection: "desc",
    });
  });

  it("sends the UI status filter as the derived deployment status", () => {
    expect(apiParams({ status: "draft" })).toMatchObject({ deploymentStatus: "draft" });
    // The stored `status` column is deliberately left alone — a draft is not
    // simply status=pending.
    expect(apiParams({ status: "draft" }).status).toBeUndefined();
    expect(apiParams({ status: "all" }).deploymentStatus).toBeUndefined();
  });

  it("resolves the relative date window against the supplied clock", () => {
    expect(apiParams({ date: "7d" }).createdAfter).toBe("2026-07-15T12:00:00.000Z");
    expect(apiParams({ date: "30d" }).createdAfter).toBe("2026-06-22T12:00:00.000Z");
    expect(apiParams({ date: "12m" }).createdAfter).toBe("2025-07-22T12:00:00.000Z");
    expect(apiParams({ date: "all" }).createdAfter).toBeUndefined();
  });

  it("omits an empty search and passes a real one through", () => {
    expect(apiParams({ search: "" }).search).toBeUndefined();
    expect(apiParams({ search: "usdc" }).search).toBe("usdc");
  });

  it("passes the template filter through untouched", () => {
    // Legacy ids still exist on older tokens, so this is not normalised.
    expect(apiParams({ template: "rwa" }).template).toBe("rwa");
    expect(apiParams({ template: "all" }).template).toBeUndefined();
  });
});

describe("toIssuanceListUrlParams", () => {
  it("clears every param for the default state", () => {
    expect(toIssuanceListUrlParams(DEFAULT_ISSUANCE_LIST_QUERY)).toEqual({
      search: null,
      status: null,
      template: null,
      date: null,
      sort: null,
      page: null,
      pageSize: null,
    });
  });

  it("keeps only what was actually chosen", () => {
    expect(
      toIssuanceListUrlParams(query({ search: "usdc", status: "active", page: 2 }))
    ).toMatchObject({
      search: "usdc",
      status: "active",
      page: "2",
      template: null,
      date: null,
      sort: null,
    });
  });

  it("round-trips through the parser", () => {
    const original = query({
      search: "acme",
      status: "paused",
      template: "stablecoin",
      date: "12m",
      sort: "name-desc",
      page: 4,
      pageSize: 48,
    });
    const params = toIssuanceListRequestParams(original);
    expect(parseIssuanceListQuery(params)).toEqual(original);
  });
});

describe("filter counting", () => {
  it("counts only narrowing filters, not sort or search", () => {
    expect(countActiveIssuanceFilters(DEFAULT_ISSUANCE_LIST_QUERY)).toBe(0);
    expect(countActiveIssuanceFilters(query({ sort: "oldest" }))).toBe(0);
    expect(countActiveIssuanceFilters(query({ search: "usdc" }))).toBe(0);
    expect(countActiveIssuanceFilters(query({ status: "draft" }))).toBe(1);
    expect(
      countActiveIssuanceFilters(query({ status: "draft", template: "custom", date: "7d" }))
    ).toBe(3);
  });

  it("treats search as narrowing when deciding empty-state copy", () => {
    expect(hasActiveIssuanceListFilters(DEFAULT_ISSUANCE_LIST_QUERY)).toBe(false);
    expect(hasActiveIssuanceListFilters(query({ sort: "oldest" }))).toBe(false);
    expect(hasActiveIssuanceListFilters(query({ search: "usdc" }))).toBe(true);
    expect(hasActiveIssuanceListFilters(query({ date: "7d" }))).toBe(true);
  });
});

describe("getIssuanceListResultSetKey", () => {
  it("ignores the page number so pages of one list share a key", () => {
    const key = getIssuanceListResultSetKey(query({ search: "usdc", page: 1 }));
    expect(getIssuanceListResultSetKey(query({ search: "usdc", page: 4 }))).toBe(key);
  });

  it("changes for anything that changes the result set", () => {
    const base = getIssuanceListResultSetKey(query());
    // Page size resizes the pages, so page 2 of one is not page 2 of the other.
    for (const changes of [
      { search: "usdc" },
      { status: "draft" as const },
      { template: "stablecoin" },
      { date: "7d" as const },
      { sort: "name-asc" as const },
      { pageSize: 48 },
    ]) {
      expect(getIssuanceListResultSetKey(query(changes))).not.toBe(base);
    }
  });
});

describe("isSameIssuanceListQuery", () => {
  it("matches identical state and rejects any difference", () => {
    expect(isSameIssuanceListQuery(query(), query())).toBe(true);
    expect(isSameIssuanceListQuery(query(), query({ page: 2 }))).toBe(false);
    expect(isSameIssuanceListQuery(query(), query({ search: "a" }))).toBe(false);
    expect(isSameIssuanceListQuery(query(), query({ sort: "oldest" }))).toBe(false);
  });
});
