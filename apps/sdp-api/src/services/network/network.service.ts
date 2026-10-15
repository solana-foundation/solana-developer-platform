/**
 * The Overview's Solana network snapshot: data.solana.com's readings, kept warm and shared
 * across instances, beside the mainnet cluster's health from status.solana.com. The whole path,
 * from the dashboard hook to the upstream reads: docs/architecture/network-figures.md.
 */
import type { NetworkHealthReading, NetworkSnapshot } from "@sdp/types/network-metrics";
import { DATA_API_REQUEST_TIMEOUT_MS, fetchDataApiMetrics } from "@/lib/data-api/client";
import { providerUnavailable } from "@/lib/errors";
import { createRefreshingCache } from "@/lib/refreshing-cache";
import { fetchMainnetClusterHealth, SOLANA_STATUS_REQUEST_TIMEOUT_MS } from "@/lib/solana-status";
import type { KVStore } from "@/runtime/kv";
import type { Env } from "@/types/env";
import { buildNetworkReadings, type NetworkReadings } from "./network-snapshot";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Daily figures behind a CDN that keeps each copy for hours (an s-maxage of 3 to 12 hours when
// checked): reading more often than every 3 hours mostly downloads the same 1.1 MB again. A copy
// up to two days old still serves while the API is down, carrying its own `asOf` so the Overview
// dates it.
const readingsCache = createRefreshingCache<NetworkReadings>({
  key: "network:readings:v2",
  freshForMs: 3 * HOUR_MS,
  servableForMs: 45 * HOUR_MS,
  retryAfterMs: 5 * MINUTE_MS,
  claimWaitMs: DATA_API_REQUEST_TIMEOUT_MS + 5_000,
});

// The cluster's state moves in minutes. Each reading carries when the page reported it and is
// served at most 3 minutes old: with the dashboard refetching every 5 and dropping a reading past
// 10, a working badge never lapses between refreshes.
const healthCache = createRefreshingCache<NetworkHealthReading | null>({
  key: "network:health:v2",
  freshForMs: 2 * MINUTE_MS,
  servableForMs: MINUTE_MS,
  retryAfterMs: MINUTE_MS,
  // Its own source's deadline, not the readings': a crashed health claimer never holds the
  // snapshot, which reads both caches together, for the readings' 25 seconds.
  claimWaitMs: SOLANA_STATUS_REQUEST_TIMEOUT_MS + 2_000,
});

async function loadReadings(env: Env): Promise<NetworkReadings> {
  const readings = buildNetworkReadings(await fetchDataApiMetrics(env));
  if (!readings) {
    throw providerUnavailable("data.solana.com has no complete day for the network readings", {
      provider: "solana-data",
    });
  }
  return readings;
}

async function loadHealth(): Promise<NetworkHealthReading | null> {
  const state = await fetchMainnetClusterHealth();
  return state === null ? null : { state, checkedAt: new Date().toISOString() };
}

/**
 * The Overview's network snapshot: the cached readings beside the cluster's health.
 *
 * @param env - The deployment's environment, which carries DATA_API_KEY.
 * @param kv - The shared cache store.
 * @param waitUntil - The request's background runner, which keeps a refresh behind a stale copy
 *   alive past the response.
 * @returns The snapshot; its health is null when the status page could not be read.
 * @throws PROVIDER_UNAVAILABLE (or PROVIDER_NOT_CONFIGURED) only when no copy of the readings
 *   can be served.
 */
export async function readNetworkSnapshot(
  env: Env,
  kv: KVStore,
  waitUntil: (promise: Promise<unknown>) => void
): Promise<NetworkSnapshot> {
  const [readings, health] = await Promise.all([
    readingsCache.read({ kv, waitUntil, load: () => loadReadings(env) }),
    // No badge beats a wrong one: a failed health read leaves it off.
    healthCache.read({ kv, waitUntil, load: loadHealth }).catch(() => null),
  ]);
  return { ...readings, health };
}

/** @internal Test-only: forget both caches. */
export function resetNetworkCachesForTests(): void {
  readingsCache.resetForTests();
  healthCache.resetForTests();
}
