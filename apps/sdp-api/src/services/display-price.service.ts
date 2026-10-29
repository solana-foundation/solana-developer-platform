import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { currentClusterScope } from "@sdp/rpc/scope";
import { logEvent } from "@/runtime/money-path-events";
import { createDisplayPriceStore } from "@/services/display-price-store";
import { createMintLookupCache } from "@/services/mint-lookup-cache";
import {
  type DisplayPriceAnswer,
  displayPriceCoverage,
  fetchTokensPriceBatch,
  MAX_MINTS_PER_REQUEST,
  PRICE_CACHE_TTL_MS,
  snapshotAgeIsAllowed,
} from "@/services/tokens-xyz-price-client";
import type { Env } from "@/types/env";

const LOOKUP_BUDGET_MS = 4_000;
const MAX_REQUESTS_IN_FLIGHT = 2;
const priceCache = createMintLookupCache<DisplayPriceAnswer>(PRICE_CACHE_TTL_MS, {
  expiresAtOf: (price) => price.expiresAt,
});
let activeRequests = 0;
const requestWaiters = new Set<() => void>();
let nextMissingKeyReportAt = 0;

function releaseRequestSlot(): void {
  const next = requestWaiters.values().next().value;
  if (next) next();
  else activeRequests -= 1;
}

/** Bounds this process's sockets; queued callers retain their original deadline. */
async function acquireRequestSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (activeRequests < MAX_REQUESTS_IN_FLIGHT) {
    activeRequests += 1;
    return releaseRequestSlot;
  }
  return new Promise((resolve, reject) => {
    const acquired = () => {
      requestWaiters.delete(acquired);
      signal.removeEventListener("abort", onAbort);
      resolve(releaseRequestSlot);
    };
    const onAbort = () => {
      requestWaiters.delete(acquired);
      reject(signal.reason);
    };
    requestWaiters.add(acquired);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchMissingPrices(
  env: Env,
  apiKey: string,
  mints: string[]
): Promise<Map<string, DisplayPriceAnswer>> {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(LOOKUP_BUDGET_MS);
  const owner = randomUUID();
  const prices = new Map<string, DisplayPriceAnswer>();
  let cursor = 0;
  let stopUpstream = false;
  let storeUnavailable = false;
  let budgetRefused = false;

  try {
    const store = createDisplayPriceStore(env, apiKey);
    const processBatch = async (batch: string[]): Promise<void> => {
      const claim = await store.lookup(batch, stopUpstream ? null : owner);
      for (const [mint, price] of claim.prices) prices.set(mint, price);
      if (claim.claimed.length > 0) {
        const fetched = new Map<string, DisplayPriceAnswer>();
        let release: (() => void) | undefined;
        try {
          release = await acquireRequestSlot(signal);
          signal.throwIfAborted();
          if (stopUpstream) return;
          if (await store.admitRequest()) {
            if (stopUpstream) return;
            const result = await fetchTokensPriceBatch(apiKey, claim.claimed, signal);
            for (const [mint, price] of result.prices) {
              fetched.set(mint, price);
              prices.set(mint, price);
            }
            switch (result.status) {
              case "rate_limited":
              case "unauthorized":
                stopUpstream = true;
                await store.backOff();
                break;
              case "ok":
              case "failed":
                break;
              default: {
                const unreachable: never = result.status;
                throw new Error(`Unexpected price response status: ${unreachable}`);
              }
            }
          } else {
            budgetRefused = true;
            stopUpstream = true;
          }
        } finally {
          release?.();
          await store.complete(claim.claimed, owner, fetched);
        }
      }
      // Another replica already owns these mints. Read its result without
      // starting duplicate upstream work, even when that owner fails.
      let pending = claim.pending;
      while (pending.length > 0 && !signal.aborted) {
        await delay(100, undefined, { signal });
        const shared = await store.lookup(pending, null);
        for (const [mint, price] of shared.prices) prices.set(mint, price);
        pending = shared.pending;
      }
    };

    const workers = Array.from(
      { length: Math.min(MAX_REQUESTS_IN_FLIGHT, Math.ceil(mints.length / MAX_MINTS_PER_REQUEST)) },
      async () => {
        // An upstream refusal still permits reads of later cached batches.
        while (!storeUnavailable && !signal.aborted) {
          const batch = mints.slice(cursor, cursor + MAX_MINTS_PER_REQUEST);
          if (batch.length === 0) return;
          cursor += MAX_MINTS_PER_REQUEST;
          try {
            await processBatch(batch);
          } catch (error) {
            storeUnavailable = true;
            if (!signal.aborted) {
              logEvent("warn", {
                event: "sdp_api_display_price_store_unavailable",
                error_name: error instanceof Error ? error.name : "unknown",
              });
            }
          }
        }
      }
    );
    await Promise.all(workers);
  } catch (error) {
    // Without shared coordination, a scale-out must not bypass the key's quota.
    logEvent("warn", {
      event: "sdp_api_display_price_store_unavailable",
      error_name: error instanceof Error ? error.name : "unknown",
    });
  }

  logEvent("info", {
    event: "sdp_api_display_price_lookup",
    vendor: "tokens-xyz",
    requested_count: mints.length,
    ...displayPriceCoverage(prices, mints.length),
    budget_refused: budgetRefused,
    deadline_exceeded: signal.aborted,
    duration_ms: Date.now() - startedAt,
  });
  return prices;
}

/**
 * Display-only USD estimates from Tokens.xyz, keyed by mainnet mint.
 *
 * Prices and confirmed absences are cached for 60 seconds across replicas.
 * Shared mint leases collapse concurrent misses; a shared per-key quota bounds
 * upstream traffic. Omitted, invalid and failed answers are never cached.
 * These estimates must never price a transfer, executable quote or token fee.
 *
 * @param env - API environment with a Tokens server credential and shared Redis.
 * @param mints - Mints to price; duplicates and blanks are ignored.
 * @returns Positive USD estimates for mints with eligible snapshots.
 */
export async function fetchDisplayUsdPrices(
  env: Env,
  mints: string[]
): Promise<Map<string, number>> {
  const { cluster } = currentClusterScope();
  if (cluster !== "mainnet-beta") return new Map();
  const apiKey = env.TOKENS_XYZ_API_KEY?.trim();
  if (!apiKey) {
    const now = Date.now();
    if (now >= nextMissingKeyReportAt) {
      // Keep a broken deployment visible without one warning per wallet read.
      nextMissingKeyReportAt = now + 60_000;
      logEvent("warn", { event: "sdp_price_config_missing", vendor: "tokens-xyz" });
    }
    return new Map();
  }
  nextMissingKeyReportAt = 0;
  const snapshots = await priceCache.lookup(cluster, mints, (missing) =>
    fetchMissingPrices(env, apiKey, missing)
  );
  const prices = new Map<string, number>();
  const now = Date.now();
  for (const [mint, price] of snapshots) {
    if (
      price.kind === "priced" &&
      price.expiresAt > now &&
      snapshotAgeIsAllowed(price.snapshotFetchedAt, now)
    ) {
      prices.set(mint, price.usdPrice);
    }
  }
  return prices;
}

/** @internal Test-only: reset completed local lookups; shared state belongs to Redis. */
export function clearDisplayPriceCacheForTests(): void {
  priceCache.clearForTests();
  nextMissingKeyReportAt = 0;
}
