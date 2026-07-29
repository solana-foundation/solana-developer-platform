"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";
import { useDebounce } from "@/lib/use-debounce";
import {
  DEFAULT_ISSUANCE_LIST_QUERY,
  getIssuanceListResultSetKey,
  hasActiveIssuanceListFilters,
  type IssuanceListQuery,
  isSameIssuanceListQuery,
  toIssuanceListUrlParams,
} from "./issuance-list-query";
import type { IssuanceTokenView } from "./issuance-token-fields";
import {
  fetchIssuanceTokensClientPage,
  type IssuanceTokensClientPage,
} from "./issuance-tokens-client.data";
import { getPageCount, getPageSummary } from "./pagination.utils";

// Owns the asset list's request state and the data for it.
//
// The list is server-driven: search, filters, sort and paging are one query
// object that the API answers. This hook keeps that query, mirrors it into the
// URL (shallow — no RSC round-trip per keystroke, but a shareable/reloadable
// link), and fetches pages through the dashboard BFF route. The first page comes
// from the server render, so mounting costs no extra request.

// Long enough that typing a word is one request, short enough that the list
// feels attached to the keyboard.
const SEARCH_DEBOUNCE_MS = 300;

// A prefetched page answers from cache with no fetch at all, and a warm request
// can beat the eye. Holding the loading states back this long means only a load
// that is actually worth waiting for ever paints one — nothing flashes a skeleton
// on its way past.
const LOADING_STATE_DELAY_MS = 150;

/**
 * True once `value` has held true for `delayMs`; false the instant it drops.
 * Suppresses loading states that would be gone before they could be read.
 */
function useDelayedFlag(value: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!value) {
      setElapsed(false);
      return;
    }

    const timer = globalThis.setTimeout(() => setElapsed(true), delayMs);
    return () => globalThis.clearTimeout(timer);
  }, [value, delayMs]);

  // `value &&` so dropping is immediate, without waiting for the effect to run.
  return value && elapsed;
}

const TOKENS_SWR_KEY = "issuance-tokens";

/** Unfiltered slice for surfaces that need the project, not the filtered page. */
export const ISSUANCE_UNFILTERED_QUERY: IssuanceListQuery = {
  ...DEFAULT_ISSUANCE_LIST_QUERY,
  pageSize: 100,
};

/** The query is the cache key — one entry per distinct request. */
function tokensCacheKey(query: IssuanceListQuery) {
  return [TOKENS_SWR_KEY, query] as const;
}

/**
 * Warms the SWR cache for the pages either side of the one on screen.
 *
 * A page change costs a full round-trip through the dashboard route, and that
 * route has to mint a Clerk API token before it can call the SDP API — far more
 * than the few milliseconds the query itself takes. Fetching the neighbours once
 * the current page has settled turns the usual way people read a list — one page
 * at a time, forwards or back — into a cache hit.
 *
 * Deliberately opportunistic: a failed prefetch is forgotten rather than
 * surfaced, so the click that follows fetches for real and reports its own error.
 */
function useAdjacentPagePrefetch() {
  const { mutate: writeCache } = useSWRConfig();
  // Pages already in the cache, per result set. Filters changing means a
  // different list, so the page numbers collected under the old one are dropped.
  const cachedRef = useRef<{ resultSet: string; pages: Set<number> }>({
    resultSet: "",
    pages: new Set(),
  });

  const markCached = useCallback((query: IssuanceListQuery) => {
    const resultSet = getIssuanceListResultSetKey(query);
    if (cachedRef.current.resultSet !== resultSet) {
      cachedRef.current = { resultSet, pages: new Set() };
    }
    cachedRef.current.pages.add(query.page);
  }, []);

  const prefetch = useCallback(
    (query: IssuanceListQuery, page: number) => {
      const target: IssuanceListQuery = { ...query, page };
      const resultSet = getIssuanceListResultSetKey(target);
      if (cachedRef.current.resultSet === resultSet && cachedRef.current.pages.has(page)) {
        return;
      }

      // Claimed before the request goes out so two renders can't both fetch it.
      markCached(target);
      void fetchIssuanceTokensClientPage(target)
        .then((result) => writeCache(tokensCacheKey(target), result, { revalidate: false }))
        .catch(() => {
          if (cachedRef.current.resultSet === resultSet) {
            cachedRef.current.pages.delete(page);
          }
        });
    },
    [markCached, writeCache]
  );

  return { markCached, prefetch };
}

export interface UseIssuanceTokenListOptions {
  initialQuery: IssuanceListQuery;
  initialTokens: IssuanceTokenView[];
  initialTotal: number;
}

export interface UseIssuanceTokenListResult {
  /** The active request. Read by the filter popover and the pager. */
  query: IssuanceListQuery;
  /** Live text-input value; folded into `query.search` once it settles. */
  search: string;
  setSearch: (value: string) => void;
  updateQuery: (changes: Partial<IssuanceListQuery>) => void;
  clearFilters: () => void;
  /** The current page's rows. */
  tokens: IssuanceTokenView[];
  /** Rows matching the active filters — what the pager counts against. */
  total: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  /** Is anything narrowing the list (search included)? Drives empty-state copy. */
  isFiltered: boolean;
  /** First load with nothing to show yet. */
  isInitialLoading: boolean;
  /** Re-fetching with rows already on screen — dim them, don't blank them. */
  isRefreshing: boolean;
  /**
   * A new search, filter or sort is in flight, so the visible rows answer a
   * question nobody asked any more: show placeholders in their place. Also covers
   * a first load that has no server-rendered rows to fall back on.
   */
  isLoadingNewResults: boolean;
  /**
   * Another page of the same list is in flight. The rows on screen are a truthful
   * neighbouring slice, so they stay and only dim.
   */
  isLoadingAnotherPage: boolean;
  /** Typed search text that hasn't reached the list yet — spin the input. */
  isSearchPending: boolean;
  errorMessage: string | null;
}

export function useIssuanceTokenList({
  initialQuery,
  initialTokens,
  initialTotal,
}: UseIssuanceTokenListOptions): UseIssuanceTokenListResult {
  const { replaceSearchParams } = useDashboardUrlState();
  const { mutate: writeCache } = useSWRConfig();
  const { markCached, prefetch } = useAdjacentPagePrefetch();
  const [query, setQuery] = useState<IssuanceListQuery>(initialQuery);
  const [search, setSearch] = useState(initialQuery.search);
  const debouncedSearch = useDebounce(search.trim(), SEARCH_DEBOUNCE_MS);
  // Mirrors `query` for callbacks that must read the latest value without being
  // re-created on every change.
  const queryRef = useRef(query);
  queryRef.current = query;
  // The request whose rows are currently on screen. Advanced below, once a fetch
  // has settled — see `isSameResultSet`.
  const shownQueryRef = useRef(query);

  const updateQuery = useCallback(
    (changes: Partial<IssuanceListQuery>) => {
      const next: IssuanceListQuery = {
        ...queryRef.current,
        ...changes,
        // Any change other than paging invalidates the page number — page 4 of a
        // previous result set means nothing against a new one.
        ...("page" in changes ? {} : { page: 1 }),
      };
      queryRef.current = next;
      setQuery(next);
      replaceSearchParams(toIssuanceListUrlParams(next));
    },
    [replaceSearchParams]
  );

  useEffect(() => {
    if (debouncedSearch !== queryRef.current.search) {
      updateQuery({ search: debouncedSearch });
    }
  }, [debouncedSearch, updateQuery]);

  const clearFilters = useCallback(() => {
    setSearch("");
    // Page size is a display preference, not a filter — clearing shouldn't reset it.
    updateQuery({ ...DEFAULT_ISSUANCE_LIST_QUERY, pageSize: queryRef.current.pageSize });
  }, [updateQuery]);

  // The server-rendered page, shaped exactly as the fetcher would return it.
  const initialPage = useMemo<IssuanceTokensClientPage>(
    () => ({
      tokens: initialTokens,
      total: initialTotal,
      page: initialQuery.page,
      pageSize: initialQuery.pageSize,
      hasMore: initialQuery.page * initialQuery.pageSize < initialTotal,
    }),
    [initialQuery.page, initialQuery.pageSize, initialTokens, initialTotal]
  );

  const { data, error, isLoading, isValidating } = useSWR(
    // The key is the query itself — no timestamp in it, so relative date filters
    // stay cacheable and repeat requests dedupe.
    tokensCacheKey(query),
    ([, listQuery]) => fetchIssuanceTokensClientPage(listQuery),
    {
      // The server already rendered this exact page; don't re-fetch on mount.
      fallbackData: isSameIssuanceListQuery(query, initialQuery) ? initialPage : undefined,
      // Keeps the current rows on screen while the next page loads instead of
      // flashing an empty state between pages.
      keepPreviousData: true,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );

  // Put the server-rendered page into the cache, not just into `fallbackData`.
  //
  // `fallbackData` is not a cache entry, and `keepPreviousData` returns the
  // *previous* key's data ahead of the fallback whenever the current key has no
  // entry of its own. Left as a fallback only, paging away from the first page and
  // back would re-render the page you just left — and because a fallback still
  // counts as data, `revalidateIfStale: false` meant nothing ever fetched the real
  // one, so the back arrow appeared to do nothing at all. Seeding the cache makes
  // the first page an ordinary hit like every other page that has been visited.
  useEffect(() => {
    void writeCache(tokensCacheKey(initialQuery), initialPage, { revalidate: false });
  }, [initialPage, initialQuery, writeCache]);

  const tokens = data?.tokens ?? [];
  const total = data?.total ?? 0;
  const pageCount = getPageCount(total, query.pageSize);

  // Which request the visible rows actually answer. `isValidating` is the signal:
  // with `revalidateIfStale: false` a key that already has a cache entry never
  // re-fetches, so a fetch in flight means this key had nothing of its own and
  // `keepPreviousData` is showing the previous request's rows. Only advance once
  // that settles, so mid-load this still names the request that produced them.
  if (!isValidating) {
    shownQueryRef.current = query;
  }
  const isSameResultSet =
    getIssuanceListResultSetKey(query) === getIssuanceListResultSetKey(shownQueryRef.current);
  // Nothing worth keeping: a different result set (or no rows at all) means the
  // honest thing to show is placeholders, not last question's answers.
  const isLoadingNewResults = useDelayedFlag(
    isValidating && (!isSameResultSet || tokens.length === 0),
    LOADING_STATE_DELAY_MS
  );
  const isLoadingAnotherPage = useDelayedFlag(
    isValidating && isSameResultSet && tokens.length > 0,
    LOADING_STATE_DELAY_MS
  );
  const { start: rangeStart, end: rangeEnd } = getPageSummary({
    page: query.page,
    pageSize: query.pageSize,
    total,
    shown: tokens.length,
  });

  // A shrinking result set (new filter, assets deleted) can leave the current
  // page past the end; step back to the last real page rather than showing an
  // empty list under a "Page 5 of 3" pager.
  //
  // Only ever acts on a real answer: a failed request reports total 0, and
  // clamping on that would silently rewrite a shared `?page=3` link to page 1 and
  // hide the failure behind a fresh request.
  const hasResult = Boolean(data) && !error;
  useEffect(() => {
    if (hasResult && queryRef.current.page > pageCount) {
      updateQuery({ page: pageCount });
    }
  }, [hasResult, pageCount, updateQuery]);

  // Once the page on screen has settled, fetch its neighbours in the background.
  // Waits for `isValidating` to clear so a prefetch never competes with the page
  // the reader is actually waiting for.
  useEffect(() => {
    if (!hasResult || isValidating) {
      return;
    }

    markCached(query);
    if (query.page > 1) {
      prefetch(query, query.page - 1);
    }
    if (query.page < pageCount) {
      prefetch(query, query.page + 1);
    }
  }, [hasResult, isValidating, markCached, pageCount, prefetch, query]);

  return {
    query,
    search,
    setSearch,
    updateQuery,
    clearFilters,
    tokens,
    total,
    pageCount,
    rangeStart,
    rangeEnd,
    isFiltered: hasActiveIssuanceListFilters(query),
    isInitialLoading: isLoading && tokens.length === 0,
    isRefreshing: isValidating && tokens.length > 0,
    isLoadingNewResults,
    isLoadingAnotherPage,
    // The debounce window, plus the fetch it triggers — a search change always
    // rebuilds the result set, so the input keeps the spinner until the answer
    // lands rather than handing over to nothing for a frame.
    isSearchPending:
      search.trim() !== query.search || (isLoadingNewResults && Boolean(query.search)),
    errorMessage: error ? (error instanceof Error ? error.message : String(error)) : null,
  };
}

/**
 * Unfiltered token slice for the playground's picker: the API examples need a
 * token to point at, and that must not be narrowed by the list's filters. Only
 * fetches once the playground tab is actually open.
 */
export function useIssuancePlaygroundTokens(enabled: boolean): IssuanceTokenView[] | null {
  const { data } = useSWR(
    enabled ? ([TOKENS_SWR_KEY, ISSUANCE_UNFILTERED_QUERY] as const) : null,
    ([, listQuery]) => fetchIssuanceTokensClientPage(listQuery),
    { revalidateOnFocus: false, keepPreviousData: true }
  );

  return data?.tokens ?? null;
}
