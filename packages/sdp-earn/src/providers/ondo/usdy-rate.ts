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
  // `toFixed` avoids exponent notation for tiny values; 12 places is well past
  // the API's own precision. Dividing by 100 is a two-place shift, so the
  // digit string carries 14 implied fraction places from here on.
  const [whole = "0", fraction = ""] = value.toFixed(12).split(".");
  const digits = `${whole}${fraction}`.padStart(15, "0");
  const intPart = digits.slice(0, -14).replace(/^0+(?=\d)/, "");
  const kept = digits.slice(-14, -14 + APY_DECIMAL_PLACES);
  const rebuilt = `${intPart}.${kept}`.replace(/\.?0+$/, "");
  return rebuilt === "" ? "0" : rebuilt;
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
