/**
 * A process-wide cache: a miss shares one in-flight load per key, and a failed load is never
 * stored, so the next call loads again.
 *
 * @param expiresAt - When a freshly loaded value stops being served.
 * @returns The cache.
 */
export function createProcessCache<TValue>(expiresAt: (value: TValue) => number) {
  const entries = new Map<string, { value: TValue; expiresAt: number }>();
  const loads = new Map<string, Promise<TValue>>();
  return {
    source(key: string): "cache" | "shared" | "network" {
      const entry = entries.get(key);
      if (entry && Date.now() < entry.expiresAt) return "cache";
      return loads.has(key) ? "shared" : "network";
    },
    get(key: string, load: () => Promise<TValue>): Promise<TValue> {
      const entry = entries.get(key);
      if (entry && Date.now() < entry.expiresAt) return Promise.resolve(entry.value);
      const loadInFlight = loads.get(key);
      if (loadInFlight) return loadInFlight;
      const pendingLoad = load()
        .then((value) => {
          entries.set(key, { value, expiresAt: expiresAt(value) });
          return value;
        })
        .finally(() => loads.delete(key));
      loads.set(key, pendingLoad);
      return pendingLoad;
    },
    /** Drop `key` only while it still holds `value` (compare-and-delete). */
    forget(key: string, value: TValue): void {
      if (entries.get(key)?.value === value) entries.delete(key);
    },
  };
}
