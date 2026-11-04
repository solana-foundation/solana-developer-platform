/** Prefix for fetched dashboard data; preferences and payment recovery use other keys. */
export const DASHBOARD_CACHE_STORAGE_PREFIX = "sdp.dashboard.cache";

/** Removes fetched data from both browser stores when a session ends. */
export function clearDashboardSnapshots(): void {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[name];
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (key?.startsWith(`${DASHBOARD_CACHE_STORAGE_PREFIX}.`)) {
          storage.removeItem(key);
        }
      }
    } catch {
      // Optional cache storage can be denied; logout must still complete.
    }
  }
}
