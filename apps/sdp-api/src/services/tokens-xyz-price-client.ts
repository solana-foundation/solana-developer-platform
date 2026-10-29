import { readProviderBody } from "@sdp/payments/ramps/fetch";
import { z } from "zod";
import { logVendorCallFailure, logVendorCallSuccess } from "@/runtime/vendor-calls";

/** Matches the upstream snapshot cache; refreshing earlier buys no fresher data. */
export const PRICE_CACHE_TTL_MS = 60_000;
/** Tokens accepts at most 250 mainnet mints in one snapshot request. */
export const MAX_MINTS_PER_REQUEST = 250;
// Some curated mints refresh hourly. This bounds snapshot age, not the price
// tick: Tokens can merge records from several sources. See docs/ops/display-prices.md.
const MAX_SNAPSHOT_AGE_MS = 2 * 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MARKET_SNAPSHOTS_URL = "https://api.tokens.xyz/v1/assets/market-snapshots";
const VENDOR = "tokens-xyz";
const OPERATION = "market-snapshots";

/** A confirmed absence is cacheable; a failed or omitted answer is not. */
export const displayPriceAnswerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("priced"),
    usdPrice: z.number().finite().positive(),
    snapshotFetchedAt: z.number().finite(),
    expiresAt: z.number().finite(),
  }),
  z.object({ kind: z.literal("missing"), expiresAt: z.number().finite() }),
]);
export type DisplayPriceAnswer = z.infer<typeof displayPriceAnswerSchema>;
export type DisplayPrice = Extract<DisplayPriceAnswer, { kind: "priced" }>;

/** Aggregate coverage without treating confirmed missing prices as estimates. */
export function displayPriceCoverage(
  prices: ReadonlyMap<string, DisplayPriceAnswer>,
  requestedCount: number
) {
  let confirmedMissing = 0;
  for (const price of prices.values()) {
    if (price.kind === "missing") confirmedMissing += 1;
  }
  const priced = prices.size - confirmedMissing;
  return {
    priced_count: priced,
    unpriced_count: requestedCount - priced,
    confirmed_missing_count: confirmedMissing,
  };
}

const snapshotBodySchema = z.array(z.unknown()).max(MAX_MINTS_PER_REQUEST);
const snapshotRowSchema = z.object({
  address: z.string(),
  hasMarket: z.boolean(),
  token: z.unknown(),
});
const snapshotTokenSchema = z.object({
  address: z.string(),
  price: z.number().finite().positive(),
  lastFetchedAt: z.number().finite().optional(),
});

/** Bounds snapshot age and clock skew without claiming price-tick freshness. */
export function snapshotAgeIsAllowed(fetchedAt: number, now: number): boolean {
  const ageMs = now - fetchedAt;
  return ageMs >= -MAX_CLOCK_SKEW_MS && ageMs <= MAX_SNAPSHOT_AGE_MS;
}

function parseSnapshots(rows: z.infer<typeof snapshotBodySchema>, mints: string[]) {
  const requested = new Set(mints);
  const seen = new Set<string>();
  const prices = new Map<string, DisplayPriceAnswer>();
  const now = Date.now();
  let invalidRows = 0;
  let staleRows = 0;
  let unknownAgeRows = 0;
  let maxSnapshotAgeMs = 0;
  for (const rawRow of rows) {
    const parsed = snapshotRowSchema.safeParse(rawRow);
    if (!parsed.success) {
      invalidRows += 1;
      continue;
    }
    const { address, hasMarket, token } = parsed.data;
    if (!requested.has(address) || seen.has(address)) {
      // Conflicting duplicate rows must not let response order select a price.
      prices.delete(address);
      invalidRows += 1;
      continue;
    }
    seen.add(address);
    if (!hasMarket || token === null) {
      prices.set(address, { kind: "missing", expiresAt: now + PRICE_CACHE_TTL_MS });
      continue;
    }
    const parsedToken = snapshotTokenSchema.safeParse(token);
    if (!parsedToken.success || parsedToken.data.address !== address) {
      invalidRows += 1;
      continue;
    }
    const { price, lastFetchedAt } = parsedToken.data;
    if (lastFetchedAt === undefined) {
      unknownAgeRows += 1;
      continue;
    }
    if (!snapshotAgeIsAllowed(lastFetchedAt, now)) {
      staleRows += 1;
      continue;
    }
    maxSnapshotAgeMs = Math.max(maxSnapshotAgeMs, now - lastFetchedAt);
    prices.set(address, {
      kind: "priced",
      usdPrice: price,
      snapshotFetchedAt: lastFetchedAt,
      expiresAt: now + PRICE_CACHE_TTL_MS,
    });
  }
  const coverage = displayPriceCoverage(prices, mints.length);
  return {
    prices,
    details: {
      ...coverage,
      invalid_row_count: invalidRows,
      stale_row_count: staleRows,
      unknown_age_row_count: unknownAgeRows,
      max_snapshot_age_ms: coverage.priced_count > 0 ? maxSnapshotAgeMs : undefined,
    },
  };
}

/** One bounded, authenticated request. Never retries or follows a redirect. */
export async function fetchTokensPriceBatch(
  apiKey: string,
  mints: string[],
  signal: AbortSignal
): Promise<{
  prices: Map<string, DisplayPriceAnswer>;
  status: "ok" | "failed" | "rate_limited" | "unauthorized";
}> {
  let httpStatus: number | undefined;
  const startedAt = Date.now();
  try {
    signal.throwIfAborted();
    const response = await fetch(MARKET_SNAPSHOTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ mints }),
      redirect: "error",
      signal,
    });
    httpStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Tokens market snapshots request failed");
    }
    const rows = snapshotBodySchema.parse(
      JSON.parse(await readProviderBody(response, MAX_RESPONSE_BYTES))
    );
    const { prices, details } = parseSnapshots(rows, mints);
    logVendorCallSuccess(VENDOR, OPERATION, startedAt, {
      boundary: "upstream_http",
      http_status: response.status,
      requested_count: mints.length,
      ...details,
    });
    return { prices, status: "ok" };
  } catch (error) {
    logVendorCallFailure(VENDOR, OPERATION, error, startedAt, {
      boundary: "upstream_http",
      http_status: httpStatus,
      requested_count: mints.length,
    });
    const prices = new Map<string, DisplayPriceAnswer>();
    switch (httpStatus) {
      case 429:
        return { prices, status: "rate_limited" };
      case 401:
      case 403:
        return { prices, status: "unauthorized" };
      default:
        return { prices, status: "failed" };
    }
  }
}
