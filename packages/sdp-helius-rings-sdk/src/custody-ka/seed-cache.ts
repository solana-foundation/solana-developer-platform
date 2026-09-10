/**
 * Process-level cache of derivation seeds, keyed by owner address.
 *
 * Why it exists: deriving used to be local HKDF and is now a custody round trip
 * — a signing request, a config decrypt and a DB read, with no retry or backoff
 * beneath it. One rings operation needs one seed, and the dashboard reads every
 * wallet on load, so without this a page visit costs one custody call per tile.
 *
 * Keyed on the owner rather than the wallet: the seed is a function of the owner
 * key alone, so every rings wallet under one owner shares it.
 *
 * This holds a long-lived secret in memory, and possession of the seed is
 * equivalent to possession of the shielded keys. It is bounded and expiring
 * rather than permanent, and it is strictly less exposed than the repo literal
 * it replaced. It is also per-replica, so N processes mean N cold starts.
 *
 * The cache is an optimization only. A cold or disabled cache is correct, just
 * slower, so nothing here may change what a caller observes.
 */

interface CacheEntry {
  readonly seed: Uint8Array;
  readonly expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;

const entries = new Map<string, CacheEntry>();
/** In-flight fetches, so concurrent syncs for one owner make one custody call. */
const inFlight = new Map<string, Promise<Uint8Array>>();

export interface SeedCacheConfig {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

/**
 * Returns a copy every time. Zolana copies the seed it is handed and clears only
 * its own copy, but a caller that cleared the cached array in place would leave
 * every later hit deriving from zeroes — a well-formed, wrong identity.
 */
export async function withCachedSeed(
  owner: string,
  fetch: () => Promise<Uint8Array>,
  config: SeedCacheConfig = {}
): Promise<Uint8Array> {
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;

  if (ttlMs <= 0) return await fetch();

  const cached = entries.get(owner);
  if (cached && cached.expiresAt > Date.now()) {
    return new Uint8Array(cached.seed);
  }
  if (cached) evict(owner);

  const pending = inFlight.get(owner);
  if (pending) return new Uint8Array(await pending);

  const fetching = fetch()
    .then((seed) => {
      store(owner, seed, ttlMs, config.maxEntries ?? DEFAULT_MAX_ENTRIES);
      return seed;
    })
    .finally(() => {
      inFlight.delete(owner);
    });

  inFlight.set(owner, fetching);
  return new Uint8Array(await fetching);
}

function store(owner: string, seed: Uint8Array, ttlMs: number, maxEntries: number): void {
  // Oldest-first eviction: insertion order is Map's iteration order, and every
  // entry has the same TTL, so the first key is always the nearest to expiry.
  while (entries.size >= maxEntries) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    evict(oldest.value);
  }

  entries.set(owner, { seed: new Uint8Array(seed), expiresAt: Date.now() + ttlMs });
}

function evict(owner: string): void {
  const entry = entries.get(owner);
  if (!entry) return;
  entry.seed.fill(0);
  entries.delete(owner);
}

/** Drops one owner's seed, for a re-key or a custody wallet going inactive. */
export function invalidateCachedSeed(owner: string): void {
  evict(owner);
}

/** Test seam, and the thing to call if a process ever needs to shed secrets. */
export function clearSeedCache(): void {
  for (const owner of [...entries.keys()]) evict(owner);
  inFlight.clear();
}
