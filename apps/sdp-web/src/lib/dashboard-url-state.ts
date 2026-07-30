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

  if (mode === "push") {
    window.history.pushState(null, "", nextUrl);
  } else {
    window.history.replaceState(window.history.state, "", nextUrl);
  }
  emitUrlStateChange();
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
