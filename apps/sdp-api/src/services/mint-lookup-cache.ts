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

export function createMintLookupCache<T>(ttlMs: number): MintLookupCache<T> {
  const entries = new Map<string, CacheEntry<T>>();
  const inFlight = new Map<string, Promise<T | undefined>>();

  function readEntry(key: string): CacheEntry<T> | null {
    const entry = entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return null;
    }
    return entry;
  }

  /**
   * Drops every expired entry. A mint seen once is otherwise never read again to
   * expire it, and wallets collect unsolicited tokens, so without this the cache
   * would grow with every mint any wallet ever held.
   */
  function sweepExpired(): void {
    const now = Date.now();
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
                  entries.set(key, { value, expiresAt: Date.now() + ttlMs });
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
    },
    entryCountForTests() {
      return entries.size;
    },
  };
}
