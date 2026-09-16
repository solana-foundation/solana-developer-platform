import { z } from "zod";
import { BASE58_ADDRESS_PATTERN } from "@/app/dashboard/markets/base58-address";
import {
  type KaminoVaultAllocations,
  kaminoVaultAllocationsSchema,
} from "@/app/dashboard/markets/treasury-solutions/kamino-allocations-schema";
import { createSdpApiClient } from "@/lib/sdp-api";

/**
 * Upstream reader behind the Treasury Solutions "Information" column BFF:
 * per-vault allocations from Kamino's public REST API, TTL-cached in memory.
 *
 * Kamino's kvaults REST source is mainnet-only; the SWR hook keeps a
 * non-mainnet row from issuing a read at all — but a direct caller can bypass
 * that client-side gate, so this module is the server boundary and enforces
 * the same two facts itself. The vault is interpolated into the upstream URL,
 * so it must BE a public key: this module refuses anything else before it can
 * reach the URL, because a value carrying `/`, `?`, `#` or `.` would alter
 * the requested resource instead of identifying one vault. And it must be a
 * vault the SDP strategy catalogue actually fronts (the mainnet Kamino shelf
 * the Treasury page renders, `resolveAllowedVaults` below): Kamino would
 * answer ANY well-formed mainnet vault, so an unlisted one is refused before
 * it costs an upstream read. A listed address that cannot resolve there
 * still fails upstream like any other miss.
 *
 * All cache mutation lives here, deliberately outside the route handler: the
 * module-level maps are a private memoization of an otherwise stateless public
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
 *
 * The refusals happen before the cache: junk is never a real entry, and a
 * malformed read must not evict a live one from the bounded map or share an
 * in-flight read with it. A vault that is not a public key, or one the
 * catalogue does not front, is refused without costing Kamino anything.
 */
export function readVaultAllocations(vault: string): Promise<KaminoVaultAllocations> {
  if (!BASE58_ADDRESS_PATTERN.test(vault)) {
    return Promise.reject(new Error("vault must be a Solana public key"));
  }
  return resolveAllowedVaults().then((allowed) => {
    if (!allowed.has(vault)) {
      throw new Error("vault is not fronted by a listed strategy");
    }
    return readListedVaultAllocations(vault);
  });
}

async function readListedVaultAllocations(vault: string): Promise<KaminoVaultAllocations> {
  const cached = allocationsCache.get(vault);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
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

// ---------------------------------------------------------------------------
// The vault allowlist. The allocations read would otherwise relay any
// well-formed mainnet address to Kamino, so a vault is admitted only if the
// SDP strategy catalogue actually fronts it — the same catalogue the Treasury
// page renders, read through the same authenticated client every other earn
// BFF route uses. It is the source of truth on purpose: a hand-copied address
// list would duplicate the API's curation and drift the first time a vault is
// added or retired.
// ---------------------------------------------------------------------------

/** The one provider whose strategies name Kamino vaults on the catalogue. */
const KAMINO_PROVIDER_ID = "kamino";
/** Allocations are a mainnet-only source, so the allowlist reads the
 * mainnet-beta shelf explicitly — the same opt-in the strategies proxy route
 * passes for the mirrored catalogue a sandbox dashboard browses. */
const ALLOWLIST_CLUSTER = "mainnet-beta";
/** The catalogue read shares the allocations TTL: one resolution per window
 * across every dashboard tab, so the added read never multiplies load. */
const ALLOWLIST_TTL_MS = ALLOCATIONS_TTL_MS;
/** The page window the API enforces (100 max) and the dashboard's own
 * strategy readers page with. */
const STRATEGIES_PAGE_SIZE = 100;
/** Hard stop on the paging loop, the same safety limit `fetchEarnStrategies`
 * enforces in the browser. */
const STRATEGIES_PAGE_LIMIT = 20;

/** Minimal page shape the allowlist actually reads; anything else fails
 * closed into the route's generic 502 instead of narrowing the allowlist. */
const strategiesPageSchema = z.object({
  strategies: z.array(
    z.object({
      provider: z.string(),
      providerReference: z.string(),
      hostCluster: z.string(),
    })
  ),
  total: z.number(),
});

async function readAllowedVaults(
  listStrategies: (path: string) => Promise<unknown>
): Promise<ReadonlySet<string>> {
  const vaults = new Set<string>();
  let listed = 0;
  for (let page = 1; page <= STRATEGIES_PAGE_LIMIT; page += 1) {
    const response = strategiesPageSchema.parse(
      await listStrategies(
        `/v1/earn/strategies?cluster=${ALLOWLIST_CLUSTER}&page=${page}&pageSize=${STRATEGIES_PAGE_SIZE}`
      )
    );
    for (const strategy of response.strategies) {
      listed += 1;
      if (strategy.provider === KAMINO_PROVIDER_ID && strategy.hostCluster === ALLOWLIST_CLUSTER) {
        vaults.add(strategy.providerReference);
      }
    }
    if (listed >= response.total) return vaults;
    // The client's own strategy reader throws on a short page rather than
    // serving a partial list, because a silently short page is hidden money;
    // here a silently short page is a silently NARROWED allowlist — vaults
    // the page renders would wear the placeholder like retired ones.
    if (response.strategies.length < STRATEGIES_PAGE_SIZE) {
      throw new Error("Earn strategies pagination ended before the reported total");
    }
  }
  throw new Error("Earn strategies pagination exceeded its safety limit");
}

interface AllowlistCacheEntry {
  expiresAt: number;
  vaults: ReadonlySet<string>;
}

let allowlistCache: AllowlistCacheEntry | undefined;
// Concurrent misses share one catalogue resolution, mirroring the in-flight
// allocations reads above.
let inFlightAllowlist: Promise<ReadonlySet<string>> | undefined;

/**
 * The vault set the catalogue fronts, at most one catalogue read per TTL
 * window no matter how many concurrent callers arrive: hits resolve
 * immediately, misses coalesce on the in-flight resolution, and a failed
 * resolution is rejected to every waiter without being cached — an
 * unavailable catalogue REFUSES the allocation read (fail closed) rather than
 * allowing an unlisted one.
 */
export function resolveAllowedVaults(): Promise<ReadonlySet<string>> {
  if (allowlistCache && allowlistCache.expiresAt > Date.now()) {
    return Promise.resolve(allowlistCache.vaults);
  }
  if (inFlightAllowlist) return inFlightAllowlist;
  const resolution = createSdpApiClient()
    .then((client) => readAllowedVaults((path) => client.fetch<unknown>(path)))
    .then((vaults) => {
      allowlistCache = { expiresAt: Date.now() + ALLOWLIST_TTL_MS, vaults };
      return vaults;
    })
    .finally(() => {
      inFlightAllowlist = undefined;
    });
  inFlightAllowlist = resolution;
  return resolution;
}

/**
 * Test-only: drop the module-scope allowlist state so specs are
 * order-independent. Production never calls this.
 *
 * @internal
 */
export function resetAllowedVaultsForTests(): void {
  allowlistCache = undefined;
  inFlightAllowlist = undefined;
}
