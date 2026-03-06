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

export function useDashboardUrlState() {
  const search = useSyncExternalStore(subscribe, getSearchSnapshot, getServerSearchSnapshot);

  const searchParams = useMemo(() => new URLSearchParams(search), [search]);

  const replaceSearchParams = useCallback((updates: Record<string, string | null>) => {
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

    window.history.replaceState(window.history.state, "", nextUrl);
    emitUrlStateChange();
  }, []);

  return {
    searchParams,
    replaceSearchParams,
  };
}
