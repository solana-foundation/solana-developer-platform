"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

const DASHBOARD_URL_STATE_EVENT = "sdp-dashboard-url-state";

function getSearchSnapshot(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.location.search;
}

function getServerSearchSnapshot(): string {
  return "";
}

function subscribe(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleChange = () => onStoreChange();

  window.addEventListener("popstate", handleChange);
  window.addEventListener(DASHBOARD_URL_STATE_EVENT, handleChange);

  return () => {
    window.removeEventListener("popstate", handleChange);
    window.removeEventListener(DASHBOARD_URL_STATE_EVENT, handleChange);
  };
}

function emitUrlStateChange() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(DASHBOARD_URL_STATE_EVENT));
}

/**
 * Applies search-param updates to the current URL via the native History API,
 * so the change stays shallow (no RSC refetch). Next.js patches pushState and
 * replaceState, so `useSearchParams` consumers stay in sync too.
 *
 * @param updates - Param values to set; null or blank values delete the param.
 * @param mode - "push" adds a history entry, "replace" rewrites the current one.
 */
function applySearchParamUpdates(updates: Record<string, string | null>, mode: "push" | "replace") {
  if (typeof window === "undefined") {
    return;
  }

  const nextParams = new URLSearchParams(window.location.search);

  for (const [key, value] of Object.entries(updates)) {
    if (value?.trim()) {
      nextParams.set(key, value);
    } else {
      nextParams.delete(key);
    }
  }

  const nextQuery = nextParams.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextUrl === currentUrl) {
    return;
  }
  if (mode === "push") {
    window.history.pushState(null, "", nextUrl);
  } else {
    window.history.replaceState(window.history.state, "", nextUrl);
  }
  emitUrlStateChange();
}

/**
 * Reads the active dashboard tab straight from the current URL, bypassing the
 * reactive snapshot behind `useDashboardTab`. Use where the snapshot can lag
 * the real URL: App Router `<Link>` navigation fires no popstate/custom event,
 * and hydration renders always start from the null server snapshot.
 *
 * @returns The live `?tab=` value, or null when absent (or on the server).
 */
export function readDashboardTabFromUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return new URLSearchParams(window.location.search).get("tab");
}

/**
 * Subscribes to a single search param, snapshotting just its value so
 * unrelated search-param churn (filters, pagination, other params) never
 * re-renders the subscriber.
 *
 * @param name - The search param to read.
 * @returns The param's current value, or null when absent (always null on the server).
 */
export function useDashboardSearchParam(name: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(getSearchSnapshot()).get(name),
    () => null
  );
}

/**
 * Applies search-param updates to the current URL as a shallow history
 * replacement; no-ops when nothing would change. Non-hook counterpart of
 * `useDashboardUrlState().replaceSearchParams` for call sites that must not
 * subscribe to the whole search string.
 *
 * @param updates - Param values to set; null or blank values delete the param.
 */
export function replaceDashboardSearchParams(updates: Record<string, string | null>): void {
  applySearchParamUpdates(updates, "replace");
}

/**
 * Reads the active dashboard tab from the URL's `?tab=` param. Every tab-aware
 * surface (header tabs, tab shell, workspaces) derives from this hook so the
 * `?tab=` contract lives in one place; call sites compare against their own
 * tab ids.
 *
 * @returns The active tab id, or null when the default tab is selected.
 */
export function useDashboardTab(): string | null {
  return useDashboardSearchParam("tab");
}

export function useDashboardUrlState() {
  const search = useSyncExternalStore(subscribe, getSearchSnapshot, getServerSearchSnapshot);

  const searchParams = useMemo(() => new URLSearchParams(search), [search]);

  const replaceSearchParams = useCallback((updates: Record<string, string | null>) => {
    applySearchParamUpdates(updates, "replace");
  }, []);

  const pushSearchParams = useCallback((updates: Record<string, string | null>) => {
    applySearchParamUpdates(updates, "push");
  }, []);

  return {
    searchParams,
    replaceSearchParams,
    pushSearchParams,
  };
}
