"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useDebounce } from "@/lib/use-debounce";

export interface UrlTableQueryAdapter<State> {
  read: (state: State) => string;
  write: (state: State, query: string) => State;
  /** Inputs shorter than this after trimming are represented as an empty query. */
  minLength?: number;
  /** Inputs longer than this after trimming are truncated before reaching the URL. */
  maxLength?: number;
}

interface UseUrlTableFiltersOptions<State extends object> {
  /** The state represented by the latest server-rendered rows. */
  returnedState: State;
  /** Produces the complete pathname and query string for a state. */
  href: (state: State) => string;
  /** Identifies the one deferred text query among the immediate filters. */
  query: UrlTableQueryAdapter<State>;
  debounceMs?: number;
}

type StateUpdate<State> = Partial<State> | ((current: State) => State);

function normalizeQuery<State>(input: string, adapter: UrlTableQueryAdapter<State>): string {
  const trimmed = input.trim();
  const minLength = adapter.minLength ?? 1;
  if (trimmed.length < minLength) {
    return "";
  }
  return adapter.maxLength === undefined ? trimmed : trimmed.slice(0, adapter.maxLength);
}

export interface UrlTableFilters<State extends object> {
  /** The latest intended filter state, updated optimistically before the server returns. */
  state: State;
  queryInput: string;
  setQueryInput: (input: string) => void;
  /** Applies immediate filters and flushes the live query into the same URL write. */
  updateFilters: (update: StateUpdate<State>) => void;
  /** Replaces the whole filter state, including the live query input. */
  resetFilters: (state: State) => void;
  /** Identity of the filters that produced the currently returned rows. */
  resultKey: string;
  isPending: boolean;
}

/**
 * Coordinates an RSC-backed table's immediate filters, deferred text query,
 * URL writes, stale server echoes, and browser history.
 *
 * Every write starts from one mutable snapshot. An immediate filter change
 * also flushes the current valid query, so it cannot race a pending debounce
 * with a different snapshot. Returned server state is accepted only when it
 * matches either the latest requested URL or the browser's current URL.
 */
export function useUrlTableFilters<State extends object>({
  returnedState,
  href,
  query,
  debounceMs = 300,
}: UseUrlTableFiltersOptions<State>): UrlTableFilters<State> {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const hrefRef = useRef(href);
  const queryRef = useRef(query);
  const returnedStateRef = useRef(returnedState);
  const resultKey = href(returnedState);

  const desiredStateRef = useRef(returnedState);
  const [state, setState] = useState(returnedState);
  const initialQuery = query.read(returnedState);
  const queryInputRef = useRef(initialQuery);
  const [queryInput, setQueryInputState] = useState(initialQuery);
  const browserNavigationRef = useRef(false);
  const debouncedQuery = useDebounce(normalizeQuery(queryInput, query), debounceMs);

  useEffect(() => {
    hrefRef.current = href;
    queryRef.current = query;
    returnedStateRef.current = returnedState;
  }, [href, query, returnedState]);

  const setQueryInput = useCallback((input: string) => {
    queryInputRef.current = input;
    setQueryInputState(input);
  }, []);

  const commit = useCallback(
    (next: State) => {
      if (hrefRef.current(next) === hrefRef.current(desiredStateRef.current)) {
        return;
      }
      desiredStateRef.current = next;
      setState(next);
      startTransition(() => router.replace(hrefRef.current(next), { scroll: false }));
    },
    [router]
  );

  const updateFilters = useCallback(
    (update: StateUpdate<State>) => {
      const adapter = queryRef.current;
      const current = adapter.write(
        desiredStateRef.current,
        normalizeQuery(queryInputRef.current, adapter)
      );
      const next = typeof update === "function" ? update(current) : { ...current, ...update };
      commit(next);
    },
    [commit]
  );

  const resetFilters = useCallback(
    (next: State) => {
      const nextQuery = queryRef.current.read(next);
      queryInputRef.current = nextQuery;
      setQueryInputState(nextQuery);
      commit(next);
    },
    [commit]
  );

  useEffect(() => {
    const markBrowserNavigation = () => {
      browserNavigationRef.current = true;
    };
    window.addEventListener("popstate", markBrowserNavigation);
    return () => window.removeEventListener("popstate", markBrowserNavigation);
  }, []);

  useEffect(() => {
    const returned = returnedStateRef.current;
    const desiredKey = hrefRef.current(desiredStateRef.current);
    const locationKey = `${window.location.pathname}${window.location.search}`;
    const matchesDesired = resultKey === desiredKey;
    const matchesLocation = resultKey === locationKey;

    // A slower RSC response from an older replace must not roll back a newer
    // filter selection or consume the pending browser-history synchronization.
    if (!matchesDesired && !matchesLocation) {
      return;
    }

    const cameFromExternalNavigation =
      matchesLocation && (browserNavigationRef.current || !matchesDesired);
    desiredStateRef.current = returned;
    setState(returned);

    if (cameFromExternalNavigation) {
      const returnedQuery = queryRef.current.read(returned);
      queryInputRef.current = returnedQuery;
      setQueryInputState(returnedQuery);
      browserNavigationRef.current = false;
    }
  }, [resultKey]);

  useEffect(() => {
    const adapter = queryRef.current;
    // A navigation adopted during this render supersedes the old debounce.
    if (debouncedQuery !== normalizeQuery(queryInputRef.current, adapter)) {
      return;
    }
    if (debouncedQuery === adapter.read(desiredStateRef.current)) {
      return;
    }
    commit(adapter.write(desiredStateRef.current, debouncedQuery));
  }, [commit, debouncedQuery]);

  return {
    state,
    queryInput,
    setQueryInput,
    updateFilters,
    resetFilters,
    resultKey,
    isPending,
  };
}
