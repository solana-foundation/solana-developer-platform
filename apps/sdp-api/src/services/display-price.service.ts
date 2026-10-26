import { currentClusterScope } from "@sdp/rpc/scope";
import { logEvent } from "@/runtime/money-path-events";
import { logVendorCallFailure } from "@/runtime/vendor-calls";
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

/**
 * Conservative. The documented ceiling is not published and a URL that is too long fails
 * as an opaque 4xx, so requests are chunked well under any plausible limit.
 */
const MAX_MINTS_PER_REQUEST = 50;
const MAX_TOKENS_XYZ_MINTS_PER_REQUEST = 250;

const REQUEST_TIMEOUT_MS = 4_000;

/** A spot price is fresh enough for a balance view for this long, and no longer. */
const PRICE_CACHE_TTL_MS = 30_000;

const priceCache = createMintLookupCache<number>(PRICE_CACHE_TTL_MS);

function logPriceLookupSuccess(vendor: string, operation: string, startedAt: number): void {
  logEvent("info", {
    event: "sdp_api_vendor_call",
    vendor,
    operation,
    outcome: "succeeded",
    duration_ms: Date.now() - startedAt,
  });
}

/** @internal Test-only: forget cached prices so specs are order-independent. */
export function clearDisplayPriceCacheForTests(): void {
  priceCache.clearForTests();
}

interface JupiterPriceEntry {
  usdPrice?: number;
}

/**
 * Base URL and credentials for the price API.
 *
 * The gateway allows keyless calls at a lower rate; the configured price key
 * raises the limit without changing the endpoint.
 */
function resolveJupiterPriceConfig(env: Env): { url: string; apiKey: string | null } {
  const apiKey = env.JUPITER_PRICE_API_KEY?.trim() || null;
  return {
    url: env.JUPITER_PRICE_API_URL?.trim() || JUPITER_PRICE_URL,
    apiKey,
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
  mints: string[]
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const requested = new Set(mints);
  const requestUrl = `${url}?${new URLSearchParams({ ids: mints.join(",") }).toString()}`;

  const startedAt = Date.now();
  const response = await fetch(requestUrl, {
    headers: apiKey ? { "x-api-key": apiKey } : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    logVendorCallFailure("jupiter", "price", error, startedAt);
    throw error;
  });
  if (!response.ok) {
    logVendorCallFailure(
      "jupiter",
      "price",
      new Error(`price request returned ${response.status}`),
      startedAt
    );
    return prices;
  }

  // A mint Jupiter cannot price reliably is omitted from the object entirely — no null
  // entry and no error — so absence is the only signal that a price is unavailable.
  const body = (await response.json().catch((error: unknown) => {
    logVendorCallFailure("jupiter", "price", error, startedAt);
    throw error;
  })) as Record<string, JupiterPriceEntry | null>;
  logPriceLookupSuccess("jupiter", "price", startedAt);
  for (const [mint, entry] of Object.entries(body ?? {})) {
    const usdPrice = entry?.usdPrice;
    if (
      requested.has(mint) &&
      typeof usdPrice === "number" &&
      Number.isFinite(usdPrice) &&
      usdPrice > 0
    ) {
      prices.set(mint, usdPrice);
    }
  }

  return prices;
}

/** Tokens.xyz only covers registered mainnet mints with a market snapshot. */
async function fetchTokensXyzPriceChunk(
  apiKey: string,
  mints: string[]
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const requested = new Set(mints);
  const startedAt = Date.now();
  const response = await fetch(TOKENS_XYZ_MARKET_SNAPSHOTS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ mints }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    logVendorCallFailure("tokens-xyz", "market-snapshots", error, startedAt);
    throw error;
  });
  if (!response.ok) {
    logVendorCallFailure(
      "tokens-xyz",
      "market-snapshots",
      new Error(`market snapshots request returned ${response.status}`),
      startedAt
    );
    return prices;
  }

  const body: unknown = await response.json().catch((error: unknown) => {
    logVendorCallFailure("tokens-xyz", "market-snapshots", error, startedAt);
    throw error;
  });
  if (!Array.isArray(body)) {
    logVendorCallFailure(
      "tokens-xyz",
      "market-snapshots",
      new Error("market snapshots response is not an array"),
      startedAt
    );
    return prices;
  }
  logPriceLookupSuccess("tokens-xyz", "market-snapshots", startedAt);
  for (const rawRow of body as unknown[]) {
    if (typeof rawRow !== "object" || rawRow === null) continue;
    if (!("address" in rawRow) || typeof rawRow.address !== "string") continue;
    if (!("hasMarket" in rawRow) || rawRow.hasMarket !== true) continue;
    if (!("token" in rawRow) || typeof rawRow.token !== "object" || rawRow.token === null) {
      continue;
    }
    const { address, token } = rawRow;
    if (!requested.has(address) || !("address" in token) || token.address !== address) continue;
    if (!("price" in token) || typeof token.price !== "number") continue;
    if (Number.isFinite(token.price) && token.price > 0) {
      prices.set(address, token.price);
    }
  }
  return prices;
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
    if (tokensXyzApiKey) {
      const tokensResults = await Promise.allSettled(
        chunk(missingMints, MAX_TOKENS_XYZ_MINTS_PER_REQUEST).map((batch) =>
          fetchTokensXyzPriceChunk(tokensXyzApiKey, batch)
        )
      );
      for (const result of tokensResults) {
        if (result.status !== "fulfilled") continue;
        for (const [mint, price] of result.value) {
          prices.set(mint, price);
        }
      }
    }

    const unpriced = missingMints.filter((mint) => !prices.has(mint));
    // Chunks are independent, so one failing batch must not discard the others.
    const jupiterResults = await Promise.allSettled(
      chunk(unpriced, MAX_MINTS_PER_REQUEST).map((batch) => fetchPriceChunk(url, apiKey, batch))
    );
    for (const result of jupiterResults) {
      if (result.status !== "fulfilled") continue;
      for (const [mint, price] of result.value) {
        prices.set(mint, price);
      }
    }

    return prices;
  });
}
