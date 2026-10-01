import { internalError } from "../../errors";
import { providerFetchJson } from "../../fetch";
import { CATALOGUE_RPC_TIMEOUT_MS } from "../../solana-rpc";

/**
 * USDY's published rate and size, from Ondo's public assets API (PRO-1833).
 *
 * `GET https://ondo.finance/api/v1/assets` — the endpoint Ondo pointed SDP at
 * (2026-09-15) — is keyless and answers one JSON body listing Ondo's yield
 * products, `usdy` among them, with `apy` as a PERCENT (3.5999… = 3.60%, the
 * figure ondo.finance shows) and `tvlUsd` per chain. `/assets/history` carries
 * the daily series; nothing here needs it.
 *
 * - **Figure.** The percent becomes a six-place decimal fraction by string
 *   surgery on the number's shortest round-trip form, TRUNCATED never rounded
 *   up (`3.5999629806` → `"0.035999"`) — the same directional rule as every
 *   other provider's rate. `tvlUsd.solana` rides along as the row's TVL.
 * - **Cadence and cost.** Written by the HOURLY catalogue sync: Ondo sets the
 *   rate monthly, so the five-minute metrics pass would buy nothing. One GET
 *   per hourly pass per deployment (the sandbox lane short-circuits before any
 *   fetch: Ondo has no devnet deployment), well inside any public rate limit.
 * - **Failure.** A 429 or 5xx, a missing `usdy` entry, or a malformed `apy`
 *   THROWS and the Ondo pass fails with it: rows keep their last figures and
 *   the outage is logged as a vendor failure, rather than the sync nulling a
 *   rate the dashboard was showing. Nothing is retried here — the next hourly
 *   pass is the retry.
 *
 * This is NOT the credentialed GM (Ondo Stocks) API at `api.gm.ondo.finance`:
 * that lists tokenized equities only and has no USDY or yield field (verified
 * with a key, 2026-09-15).
 */

export const ONDO_ASSETS_API_URL = "https://ondo.finance/api/v1/assets";

/** Same retained precision as the other providers' rates. */
const APY_DECIMAL_PLACES = 6;

interface OndoAssetsResponse {
  timestamp?: string;
  assets?: OndoAssetEntry[];
}

interface OndoAssetEntry {
  symbol?: string;
  name?: string;
  priceUsd?: number;
  apy?: number;
  tvlUsd?: Record<string, number | undefined>;
}

export interface OndoUsdyRate {
  /** Annualized rate as a decimal-fraction string, e.g. `"0.035999"`. */
  currentApy: string;
  /** USDY supply on Solana in USD, when the API reports it. */
  solanaTvlUsd?: number;
}

/**
 * Percent → decimal fraction, truncated to `APY_DECIMAL_PLACES`, by string
 * surgery: `3.5999629806` → `"0.035999"`. Refuses anything that is not a
 * finite non-negative number, so a fabricated 0% can never come out of a
 * malformed field.
 */
export function ondoPercentToDecimalString(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw internalError(`Ondo USDY apy is not a non-negative number: ${String(value)}`);
  }
  // Keep the supplied decimal digits: toFixed rounds before truncation and
  // can raise a rate across the retained precision boundary.
  const [coefficient = "0", exponent = "0"] = String(value).split("e");
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  const scale = Number(exponent) - fraction.length - 2 + APY_DECIMAL_PLACES;
  const retained = scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale);
  const text = retained.toString().padStart(APY_DECIMAL_PLACES + 1, "0");
  return `${text.slice(0, -APY_DECIMAL_PLACES)}.${text.slice(-APY_DECIMAL_PLACES)}`.replace(
    /\.?0+$/,
    ""
  );
}

export async function readOndoUsdyRate(
  url: string = ONDO_ASSETS_API_URL,
  timeoutMs: number = CATALOGUE_RPC_TIMEOUT_MS
): Promise<OndoUsdyRate> {
  const body = await providerFetchJson<OndoAssetsResponse>("ondo", url, {
    method: "GET",
    timeoutMs,
  });
  const entry = body?.assets?.find((asset) => asset?.symbol?.toLowerCase() === "usdy");
  if (!entry) {
    throw internalError("Ondo assets API listed no usdy entry");
  }
  const solanaTvlUsd = entry.tvlUsd?.solana;
  return {
    currentApy: ondoPercentToDecimalString(entry.apy),
    ...(typeof solanaTvlUsd === "number" && Number.isFinite(solanaTvlUsd) && solanaTvlUsd >= 0
      ? { solanaTvlUsd }
      : {}),
  };
}
