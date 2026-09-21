import { logVendorCallFailure } from "@/runtime/vendor-calls";
import { createMintLookupCache } from "@/services/mint-lookup-cache";
import type { Env } from "@/types/env";

/**
 * USD spot prices from Jupiter.
 *
 * Helius DAS reports a price only for assets it happens to know, which leaves anything
 * that is neither USD-stable nor in its index unpriced. Jupiter prices from the last
 * swapped price across all venues, so it covers the long tail this platform actually
 * issues and holds.
 */

const JUPITER_LITE_PRICE_URL = "https://lite-api.jup.ag/price/v3";

/**
 * Conservative. The documented ceiling is not published and a URL that is too long fails
 * as an opaque 4xx, so requests are chunked well under any plausible limit.
 */
const MAX_MINTS_PER_REQUEST = 50;

const REQUEST_TIMEOUT_MS = 4_000;

/** A spot price is fresh enough for a balance view for this long, and no longer. */
const PRICE_CACHE_TTL_MS = 30_000;

const priceCache = createMintLookupCache<number>(PRICE_CACHE_TTL_MS);

/** @internal Test-only: forget cached prices so specs are order-independent. */
export function clearJupiterPriceCacheForTests(): void {
  priceCache.clearForTests();
}

interface JupiterPriceEntry {
  usdPrice?: number;
}

/**
 * Base URL and credentials for the price API.
 *
 * The lite endpoint needs no key but is rate limited, so it is only a default: setting
 * `JUPITER_PRICE_API_URL` with `JUPITER_PRICE_API_KEY` moves traffic to the keyed tier.
 */
function resolveJupiterPriceConfig(env: Env): { url: string; apiKey: string | null } {
  return {
    url: env.JUPITER_PRICE_API_URL?.trim() || JUPITER_LITE_PRICE_URL,
    apiKey: env.JUPITER_PRICE_API_KEY?.trim() || null,
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
  for (const [mint, entry] of Object.entries(body ?? {})) {
    const usdPrice = entry?.usdPrice;
    if (typeof usdPrice === "number" && Number.isFinite(usdPrice) && usdPrice >= 0) {
      prices.set(mint, usdPrice);
    }
  }

  return prices;
}

/**
 * USD prices for the mints Jupiter can price. Mints it cannot are absent from the result
 * rather than present with a zero, so a caller can tell "worth nothing" from "unknown".
 *
 * A price is reused for 30 seconds per cluster and mint. A mint left unpriced, by
 * Jupiter or by a failed batch, is asked about again on the next call.
 *
 * Never throws. Pricing decorates a balance response; a pricing outage should render
 * balances unpriced, not fail the request that carries them.
 */
export async function fetchJupiterUsdPrices(
  env: Env,
  mints: string[]
): Promise<Map<string, number>> {
  const { url, apiKey } = resolveJupiterPriceConfig(env);

  return priceCache.lookup(env.SOLANA_NETWORK ?? "devnet", mints, async (missingMints) => {
    const prices = new Map<string, number>();
    // Chunks are independent, so one failing batch must not discard the others.
    const results = await Promise.allSettled(
      chunk(missingMints, MAX_MINTS_PER_REQUEST).map((batch) => fetchPriceChunk(url, apiKey, batch))
    );

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const [mint, price] of result.value) {
        prices.set(mint, price);
      }
    }

    return prices;
  });
}
