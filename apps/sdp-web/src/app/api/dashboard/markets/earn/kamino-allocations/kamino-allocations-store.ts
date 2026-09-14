import {
  type KaminoVaultAllocations,
  kaminoVaultAllocationsSchema,
} from "@/app/dashboard/markets/treasury-solutions/kamino-allocations-schema";

/**
 * Upstream reader behind the Treasury Solutions "Information" column BFF:
 * per-vault allocations from Kamino's public REST API, TTL-cached in memory.
 *
 * Kamino's kvaults REST source is mainnet-only; the BFF route refuses reads
 * for any other cluster before reaching this module, so a sandbox strategy's
 * devnet vault address is never sent upstream at all.
 *
 * All cache mutation lives here, deliberately outside the route handler: the
 * module-level map is a private memoization of an otherwise stateless public
 * read, not an externally visible side effect. Failures are honest and cached
 * NEVER: an upstream outage, a non-2xx, or a payload that does not parse
 * rejects every waiter, and the cell degrades to the same placeholder a
 * non-Kamino row shows. Nothing here logs request internals or upstream
 * payloads.
 */

const KAMINO_ALLOCATIONS_BASE = "https://api.kamino.finance/kvaults/vaults";
/** Kamino's own site re-reads allocations frequently; 45s keeps one upstream
 * read per vault across every dashboard tab without serving stale weights. */
const ALLOCATIONS_TTL_MS = 45_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const CACHE_MAX_ENTRIES = 128;
/** Base58 Solana public key, bounded to the 32-byte ed25519 range. */
export const VAULT_PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface AllocationsCacheEntry {
  expiresAt: number;
  payload: KaminoVaultAllocations;
}

const allocationsCache = new Map<string, AllocationsCacheEntry>();
// Concurrent misses for the same vault share one upstream read: the entry is
// stored before the fetch starts and removed once it settles, so a burst of
// dashboard tabs around cache expiry still costs Kamino one request.
const inFlightReads = new Map<string, Promise<KaminoVaultAllocations>>();

function cacheAllocations(vault: string, payload: KaminoVaultAllocations): void {
  // The catalogue holds tens of vaults; the bound only exists so a pathological
  // caller cycling addresses cannot grow the map without end. Insertion order
  // makes the first key the oldest, expired or not.
  if (allocationsCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = allocationsCache.keys().next().value;
    if (oldest !== undefined) allocationsCache.delete(oldest);
  }
  allocationsCache.set(vault, { expiresAt: Date.now() + ALLOCATIONS_TTL_MS, payload });
}

async function readKaminoAllocations(vault: string): Promise<KaminoVaultAllocations> {
  const response = await fetch(`${KAMINO_ALLOCATIONS_BASE}/${vault}/allocations`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Kamino allocations request failed (${response.status})`);
  }
  return kaminoVaultAllocationsSchema.parse(await response.json());
}

/**
 * One vault's allocations, at most one upstream read per TTL window no matter
 * how many concurrent callers arrive: cache hits resolve immediately, misses
 * coalesce on the in-flight read, and a failed read is rejected to every
 * waiter without being cached.
 */
export function readVaultAllocations(vault: string): Promise<KaminoVaultAllocations> {
  const cached = allocationsCache.get(vault);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.payload);
  }
  const inFlight = inFlightReads.get(vault);
  if (inFlight) return inFlight;
  const read = readKaminoAllocations(vault)
    .then((payload) => {
      cacheAllocations(vault, payload);
      return payload;
    })
    .finally(() => {
      inFlightReads.delete(vault);
    });
  inFlightReads.set(vault, read);
  return read;
}
