/**
 * An in-process cache for per-mint lookups (a price, a symbol) answered in batches.
 *
 * Every balance response used to ask the vendor again for the same mints. Entries
 * are keyed by cluster and mint and live for the caller's TTL. Only a mint the
 * vendor answered for is kept: a mint it could not answer, or a batch that failed,
 * is asked again on the next request, so an outage is never remembered as "no
 * price". A mint already being looked up is joined rather than asked twice.
 */

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export interface MintLookupCache<T> {
  /**
   * The value for each mint that has one, from the cache, a lookup already in flight,
   * or one `fetchMissing` call for the rest.
   *
   * @param cluster - The cluster the mints live on.
   * @param mints - The mints to look up; duplicates and blanks are ignored.
   * @param fetchMissing - Answers for the mints nobody has; absent from its map means
   *   no value. A rejection answers none of them, and nothing is cached.
   */
  lookup(
    cluster: string,
    mints: readonly string[],
    fetchMissing: (mints: string[]) => Promise<ReadonlyMap<string, T>>
  ): Promise<Map<string, T>>;
  /** @internal Test-only: forget every entry and lookup in flight. */
  clearForTests(): void;
  /** @internal Test-only: how many entries are held, expired or not. */
  entryCountForTests(): number;
}

/** Bounded local cache that can preserve a shared entry's original deadline. */
export function createMintLookupCache<T>(
  ttlMs: number,
  options: { expiresAtOf?: (value: T) => number; maxEntries?: number } = {}
): MintLookupCache<T> {
  const maxEntries = options.maxEntries ?? 10_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Mint cache capacity must be a positive integer");
  }
  const entries = new Map<string, CacheEntry<T>>();
  const inFlight = new Map<string, Promise<T | undefined>>();
  let nextSweepAt = 0;

  function readEntry(key: string): CacheEntry<T> | null {
    const entry = entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return null;
    }
    // Keep frequently displayed mints when a wallet introduces many new ones.
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  /**
   * Drops unused expired entries at most once per TTL. Capacity bounds memory
   * between sweeps; repeated misses never rescan the whole cache each time.
   */
  function sweepExpired(): void {
    const now = Date.now();
    if (now < nextSweepAt) return;
    nextSweepAt = now + ttlMs;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(key);
      }
    }
  }

  return {
    async lookup(cluster, mints, fetchMissing) {
      const uniqueMints = [...new Set(mints.map((mint) => mint.trim()).filter(Boolean))];
      const values = new Map<string, T>();
      const pending: Array<readonly [string, Promise<T | undefined>]> = [];
      const missing: string[] = [];

      for (const mint of uniqueMints) {
        const key = `${cluster}:${mint}`;
        const entry = readEntry(key);
        const running = inFlight.get(key);
        if (entry) {
          values.set(mint, entry.value);
        } else if (running) {
          pending.push([mint, running]);
        } else {
          missing.push(mint);
        }
      }

      if (missing.length > 0) {
        sweepExpired();
        const batch = fetchMissing(missing);
        for (const mint of missing) {
          const key = `${cluster}:${mint}`;
          const lookup: Promise<T | undefined> = batch
            .then(
              (answered) => {
                const value = answered.get(mint);
                if (value !== undefined) {
                  const expiresAt = options.expiresAtOf
                    ? Math.min(Date.now() + ttlMs, options.expiresAtOf(value))
                    : Date.now() + ttlMs;
                  if (expiresAt > Date.now()) {
                    entries.set(key, { value, expiresAt });
                    if (entries.size > maxEntries) {
                      const oldest = entries.keys().next().value;
                      if (oldest !== undefined) entries.delete(oldest);
                    }
                  }
                }
                return value;
              },
              () => undefined
            )
            .finally(() => {
              if (inFlight.get(key) === lookup) {
                inFlight.delete(key);
              }
            });
          inFlight.set(key, lookup);
          pending.push([mint, lookup]);
        }
      }

      await Promise.all(
        pending.map(async ([mint, lookup]) => {
          const value = await lookup;
          if (value !== undefined) {
            values.set(mint, value);
          }
        })
      );
      return values;
    },
    clearForTests() {
      entries.clear();
      inFlight.clear();
      nextSweepAt = 0;
    },
    entryCountForTests() {
      return entries.size;
    },
  };
}
