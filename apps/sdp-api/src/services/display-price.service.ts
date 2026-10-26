import { currentClusterScope } from "@sdp/rpc/scope";
import { z } from "zod";
import { logEvent } from "@/runtime/money-path-events";
import {
  logVendorCallFailure,
  VENDOR_CALL_EVENT,
  type VendorCallDetails,
} from "@/runtime/vendor-calls";
import { createMintLookupCache } from "@/services/mint-lookup-cache";
import type { Env } from "@/types/env";

/**
 * Display USD spot prices from Tokens.xyz, with Jupiter coverage for other mints.
 *
 * Helius DAS reports a price only for assets it happens to know, which leaves anything
 * that is neither USD-stable nor in its index unpriced. Tokens.xyz supplies
 * registered Solana mint snapshots; Jupiter covers unregistered or missing mints.
 */

const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";
const TOKENS_XYZ_MARKET_SNAPSHOTS_URL = "https://api.tokens.xyz/v1/assets/market-snapshots";

/** Jupiter accepts up to 50 mints; Tokens.xyz accepts up to 250. */
const MAX_MINTS_PER_REQUEST = 50;
const MAX_TOKENS_XYZ_MINTS_PER_REQUEST = 250;

const LOOKUP_BUDGET_MS = 4_000;
const TOKENS_PRIMARY_BUDGET_MS = 1_800;
const MAX_BATCHES_IN_FLIGHT = 2;
// Tokens.xyz refreshes each curated mint roughly hourly, independently of its 1m HTTP cache.
const MAX_TOKEN_SNAPSHOT_AGE_MS = 2 * 60 * 60_000;

/** A spot price is fresh enough for a balance view for this long, and no longer. */
const PRICE_CACHE_TTL_MS = 30_000;

const priceCache = createMintLookupCache<number>(PRICE_CACHE_TTL_MS);
let warnedAboutJupiterPriceUrl = false;

function logPriceLookupSuccess(
  vendor: string,
  operation: string,
  startedAt: number,
  details: VendorCallDetails
): void {
  logEvent("info", {
    event: VENDOR_CALL_EVENT,
    vendor,
    operation,
    outcome: "succeeded",
    duration_ms: Date.now() - startedAt,
    ...details,
  });
}

/** @internal Test-only: forget cached prices so specs are order-independent. */
export function clearDisplayPriceCacheForTests(): void {
  priceCache.clearForTests();
}

const jupiterPriceBodySchema = z.record(z.string(), z.unknown());
const jupiterPriceEntrySchema = z.object({ usdPrice: z.number().finite() }).passthrough();
const tokensSnapshotRowSchema = z
  .object({
    address: z.string(),
    hasMarket: z.boolean(),
    token: z
      .object({
        address: z.string(),
        price: z.number().finite(),
        lastFetchedAt: z.number().finite().optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

interface PriceBatchResult {
  readonly prices: Map<string, number>;
}

function emptyPriceBatchResult(): PriceBatchResult {
  return { prices: new Map() };
}

/**
 * Base URL and credentials for the price API.
 *
 * The gateway allows keyless calls at a lower rate; the configured price key
 * raises the limit without changing the endpoint.
 */
function resolveJupiterPriceConfig(env: Env): { url: string; apiKey: string | null } {
  const apiKey = env.JUPITER_PRICE_API_KEY?.trim() || null;
  const configuredUrl = env.JUPITER_PRICE_API_URL?.trim() || JUPITER_PRICE_URL;
  if (apiKey) {
    try {
      const parsed = new URL(configuredUrl);
      if (
        parsed.origin === "https://api.jup.ag" &&
        parsed.pathname === "/price/v3" &&
        parsed.search === "" &&
        parsed.hash === "" &&
        parsed.username === "" &&
        parsed.password === ""
      ) {
        return { url: parsed.toString(), apiKey };
      }
    } catch {
      // A malformed override must never receive the price API key.
    }
    if (!warnedAboutJupiterPriceUrl) {
      warnedAboutJupiterPriceUrl = true;
      logEvent("warn", {
        event: "sdp_price_config_rejected",
        vendor: "jupiter",
        reason: "keyed_url_not_allowlisted",
      });
    }
    return { url: JUPITER_PRICE_URL, apiKey };
  }
  return {
    url: configuredUrl,
    apiKey: null,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function fetchPriceChunk(
  url: string,
  apiKey: string | null,
  mints: string[],
  signal: AbortSignal
): Promise<PriceBatchResult> {
  const result = emptyPriceBatchResult();
  const requestUrl = `${url}?${new URLSearchParams({ ids: mints.join(",") }).toString()}`;

  const startedAt = Date.now();
  const response = await fetch(requestUrl, {
    headers: apiKey ? { "x-api-key": apiKey } : undefined,
    redirect: "error",
    signal,
  }).catch((error: unknown) => {
    logVendorCallFailure("jupiter", "price", error, startedAt, {
      requested_count: mints.length,
    });
    throw error;
  });
  if (!response.ok) {
    logVendorCallFailure(
      "jupiter",
      "price",
      new Error(`price request returned ${response.status}`),
      startedAt,
      { http_status: response.status, requested_count: mints.length }
    );
    return result;
  }

  // A mint Jupiter cannot price reliably is omitted from the object entirely — no null
  // entry and no error — so absence is the only signal that a price is unavailable.
  const body: unknown = await response.json().catch((error: unknown) => {
    logVendorCallFailure("jupiter", "price", error, startedAt, {
      http_status: response.status,
      requested_count: mints.length,
    });
    throw error;
  });
  const parsed = jupiterPriceBodySchema.safeParse(body);
  if (!parsed.success) {
    logVendorCallFailure("jupiter", "price", new Error("invalid price response"), startedAt, {
      http_status: response.status,
      requested_count: mints.length,
    });
    return result;
  }

  let invalidRows = 0;
  let confirmedMissing = 0;
  for (const mint of mints) {
    const row = parsed.data[mint];
    if (row === undefined || row === null) {
      confirmedMissing += 1;
      continue;
    }
    const entry = jupiterPriceEntrySchema.safeParse(row);
    if (!entry.success) {
      invalidRows += 1;
      continue;
    }
    if (entry.data.usdPrice > 0) {
      result.prices.set(mint, entry.data.usdPrice);
    } else {
      confirmedMissing += 1;
    }
  }
  logPriceLookupSuccess("jupiter", "price", startedAt, {
    http_status: response.status,
    requested_count: mints.length,
    priced_count: result.prices.size,
    confirmed_missing_count: confirmedMissing,
    invalid_row_count: invalidRows,
  });
  return result;
}

/** Tokens.xyz only covers registered mainnet mints with a market snapshot. */
async function fetchTokensXyzPriceChunk(
  apiKey: string,
  mints: string[],
  signal: AbortSignal
): Promise<PriceBatchResult> {
  const result = emptyPriceBatchResult();
  const requested = new Set(mints);
  const startedAt = Date.now();
  const response = await fetch(TOKENS_XYZ_MARKET_SNAPSHOTS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ mints }),
    redirect: "error",
    signal,
  }).catch((error: unknown) => {
    logVendorCallFailure("tokens-xyz", "market-snapshots", error, startedAt, {
      requested_count: mints.length,
    });
    throw error;
  });
  if (!response.ok) {
    logVendorCallFailure(
      "tokens-xyz",
      "market-snapshots",
      new Error(`market snapshots request returned ${response.status}`),
      startedAt,
      { http_status: response.status, requested_count: mints.length }
    );
    return result;
  }

  const body: unknown = await response.json().catch((error: unknown) => {
    logVendorCallFailure("tokens-xyz", "market-snapshots", error, startedAt, {
      http_status: response.status,
      requested_count: mints.length,
    });
    throw error;
  });
  if (!Array.isArray(body)) {
    logVendorCallFailure(
      "tokens-xyz",
      "market-snapshots",
      new Error("market snapshots response is not an array"),
      startedAt,
      { http_status: response.status, requested_count: mints.length }
    );
    return result;
  }
  let invalidRows = 0;
  let staleRows = 0;
  let unknownAgeRows = 0;
  let confirmedMissing = 0;
  let maxSnapshotAgeMs = 0;
  for (const rawRow of body) {
    const parsed = tokensSnapshotRowSchema.safeParse(rawRow);
    if (!parsed.success) {
      invalidRows += 1;
      continue;
    }
    const { address, hasMarket, token } = parsed.data;
    if (!requested.has(address) || (token && token.address !== address)) {
      invalidRows += 1;
      continue;
    }
    if (!hasMarket || token === null || token.price <= 0) {
      confirmedMissing += 1;
      continue;
    }
    if (token.lastFetchedAt === undefined) {
      unknownAgeRows += 1;
      continue;
    }
    const ageMs = Date.now() - token.lastFetchedAt;
    if (ageMs > MAX_TOKEN_SNAPSHOT_AGE_MS || ageMs < -60_000) {
      staleRows += 1;
      continue;
    }
    maxSnapshotAgeMs = Math.max(maxSnapshotAgeMs, ageMs);
    result.prices.set(address, token.price);
  }
  logPriceLookupSuccess("tokens-xyz", "market-snapshots", startedAt, {
    http_status: response.status,
    requested_count: mints.length,
    priced_count: result.prices.size,
    confirmed_missing_count: confirmedMissing,
    invalid_row_count: invalidRows,
    stale_row_count: staleRows,
    unknown_age_row_count: unknownAgeRows,
    ...(result.prices.size > 0 ? { max_snapshot_age_ms: maxSnapshotAgeMs } : {}),
  });
  return result;
}

async function fetchBatches(
  mints: string[],
  batchSize: number,
  concurrency: number,
  deadlineAt: number,
  fetchBatch: (batch: string[], signal: AbortSignal) => Promise<PriceBatchResult>
): Promise<PriceBatchResult> {
  const result = emptyPriceBatchResult();
  const batches = chunk(mints, batchSize);
  let nextBatch = 0;
  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    for (;;) {
      const remainingMs = deadlineAt - Date.now();
      const batch = batches[nextBatch];
      if (!batch || remainingMs <= 0) return;
      nextBatch += 1;
      try {
        const answered = await fetchBatch(batch, AbortSignal.timeout(remainingMs));
        for (const [mint, price] of answered.prices) result.prices.set(mint, price);
      } catch {
        // Each vendor call logs its own failure. An independent batch may still succeed.
      }
    }
  });
  await Promise.all(workers);
  return result;
}

/**
 * Display-only USD prices. Tokens.xyz is preferred for registered mints when
 * configured; Jupiter covers anything Tokens.xyz cannot price. Unpriced mints
 * are absent.
 *
 * Jupiter quotes mainnet markets only, so off mainnet every mint is unpriced: a devnet
 * mint has no market, and one sharing a mainnet address (native SOL) would borrow a
 * price it does not trade at.
 *
 * A price is reused for 30 seconds per mint. A mint left unpriced, by Jupiter or by a
 * failed batch, is asked about again on the next call.
 *
 * Never throws. Pricing decorates a balance response; a pricing outage should render
 * balances unpriced, not fail the request that carries them.
 */
export async function fetchDisplayUsdPrices(
  env: Env,
  mints: string[]
): Promise<Map<string, number>> {
  const { cluster } = currentClusterScope();
  if (cluster !== "mainnet-beta") {
    return new Map();
  }
  const { url, apiKey } = resolveJupiterPriceConfig(env);
  const tokensXyzApiKey = env.TOKENS_XYZ_API_KEY?.trim();

  return priceCache.lookup(cluster, mints, async (missingMints) => {
    const prices = new Map<string, number>();
    const lookupStartedAt = Date.now();
    const lookupDeadlineAt = lookupStartedAt + LOOKUP_BUDGET_MS;
    if (tokensXyzApiKey) {
      const tokensResult = await fetchBatches(
        missingMints,
        MAX_TOKENS_XYZ_MINTS_PER_REQUEST,
        MAX_BATCHES_IN_FLIGHT,
        Math.min(lookupDeadlineAt, Date.now() + TOKENS_PRIMARY_BUDGET_MS),
        (batch, signal) => fetchTokensXyzPriceChunk(tokensXyzApiKey, batch, signal)
      );
      for (const [mint, price] of tokensResult.prices) prices.set(mint, price);
    }

    const unpriced = missingMints.filter((mint) => !prices.has(mint));
    const jupiterResult = await fetchBatches(
      unpriced,
      MAX_MINTS_PER_REQUEST,
      apiKey ? MAX_BATCHES_IN_FLIGHT : 1,
      lookupDeadlineAt,
      (batch, signal) => fetchPriceChunk(url, apiKey, batch, signal)
    );
    for (const [mint, price] of jupiterResult.prices) prices.set(mint, price);

    logEvent("info", {
      event: "sdp_api_display_price_lookup",
      requested_count: missingMints.length,
      priced_count: prices.size,
      unpriced_count: missingMints.length - prices.size,
      duration_ms: Date.now() - lookupStartedAt,
      tokens_configured: Boolean(tokensXyzApiKey),
      jupiter_keyed: Boolean(apiKey),
    });

    return prices;
  });
}
