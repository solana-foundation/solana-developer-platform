"use client";

import { useEffect } from "react";

const LEGACY_DASHBOARD_CACHE_PREFIX = "sdp.dashboard.cache.";

// Earlier releases stored fetched dashboard data under this prefix. Nothing writes it now, so
// every match is stale private data from a previous session.
export function LegacyDashboardCachePurge() {
  useEffect(() => {
    for (const storageName of ["localStorage", "sessionStorage"] as const) {
      try {
        const storage = window[storageName];
        for (let index = storage.length - 1; index >= 0; index -= 1) {
          const storageKey = storage.key(index);
          if (storageKey?.startsWith(LEGACY_DASHBOARD_CACHE_PREFIX)) {
            storage.removeItem(storageKey);
          }
        }
      } catch (error) {
        // Browser settings can deny storage access; there is nothing to purge then.
        if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
      }
    }
  }, []);

  return null;
}
