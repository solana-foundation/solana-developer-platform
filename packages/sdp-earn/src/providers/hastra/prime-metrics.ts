import { providerUnavailable } from "../../errors";
import { providerFetchJson } from "../../fetch";

/** Hastra's keyless proof-of-reserves and product-metrics feed. */
export const HASTRA_POR_API_URL = "https://hastra.io/hastra-pulse/public/api/v1/por";
const REQUEST_TIMEOUT_MS = 10_000;

interface HastraPorTokenMetrics {
  token?: string;
  effective_rate?: string;
}

interface HastraPorResponse {
  wylds_card?: {
    wylds_ratio?: string;
  };
  prime_card?: {
    mint_address_by_chain?: {
      solana?: string;
    };
    vault_balance_by_chain?: {
      solana?: string;
    };
  };
  demo_prime_card?: {
    tokens?: HastraPorTokenMetrics[];
  };
}

export interface HastraPrimeMetrics {
  /** The Solana PRIME mint reported by Hastra and used as SDP's provider reference. */
  providerReference: string;
  /** Effective PRIME APY as a decimal fraction, e.g. `"0.061336"`. */
  currentApy: string;
  /** PRIME's Solana vault balance converted from wYLDS to USD, not the cross-chain total. */
  solanaTvlUsd: number;
}

const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const APY_DECIMAL_PLACES = 6;

/**
 * Convert Hastra's percent string to an exact decimal-fraction string without
 * passing through a JavaScript number (`"6.1336"` -> `"0.061336"`). Values
 * beyond SDP's six retained places are truncated, never rounded up.
 */
export function hastraPercentToDecimalString(value: unknown): string {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value)) {
    throw providerUnavailable(
      `Hastra PRIME effective_rate is not a non-negative decimal string: ${String(value)}`
    );
  }

  const [whole = "0", fraction = ""] = value.split(".");
  const significantDigits = `${whole}${fraction}`.replace(/^0+/, "") || "0";
  const decimalPlaces = fraction.length + 2;
  const shifted = significantDigits.padStart(decimalPlaces + 1, "0");
  const integerPart = shifted.slice(0, -decimalPlaces).replace(/^0+(?=\d)/, "");
  const fractionalPart = shifted
    .slice(-decimalPlaces)
    .slice(0, APY_DECIMAL_PLACES)
    .replace(/0+$/, "");
  return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
}

function nonNegativeDecimalNumber(value: unknown, field: string): number {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value)) {
    throw providerUnavailable(`Hastra ${field} is not a non-negative decimal string`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw providerUnavailable(`Hastra ${field} is outside the supported numeric range`);
  }
  return parsed;
}

function positiveDecimalNumber(value: unknown, field: string): number {
  const parsed = nonNegativeDecimalNumber(value, field);
  if (parsed === 0) {
    throw providerUnavailable(`Hastra ${field} must be greater than zero`);
  }
  return parsed;
}

function multiplyNonNegativeDecimals(
  left: unknown,
  leftField: string,
  right: unknown,
  rightField: string
): number {
  const product =
    nonNegativeDecimalNumber(left, leftField) * positiveDecimalNumber(right, rightField);
  if (!Number.isFinite(product)) {
    throw providerUnavailable("Hastra PRIME Solana TVL is outside the supported numeric range");
  }
  return product;
}

/**
 * Read the two PRIME figures SDP publishes from Hastra's public feed.
 *
 * The feed is cross-chain. Identity is therefore checked against the pinned
 * Solana PRIME mint before any figure is accepted. TVL converts the Solana-only
 * wYLDS vault balance to USD using Hastra's wYLDS ratio rather than publishing
 * token units or using `prime_card.vaulted_wylds` (the cross-chain total).
 */
export async function readHastraPrimeMetrics(
  expectedPrimeMint: string,
  url: string = HASTRA_POR_API_URL,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<HastraPrimeMetrics> {
  const body = await providerFetchJson<HastraPorResponse>("hastra", url, {
    method: "GET",
    timeoutMs,
  });

  const providerReference = body?.prime_card?.mint_address_by_chain?.solana;
  if (providerReference !== expectedPrimeMint) {
    throw providerUnavailable(
      `Hastra proof-of-reserves feed reported an unexpected Solana PRIME mint: ${String(providerReference)}`
    );
  }

  const tokens = body?.demo_prime_card?.tokens;
  if (!Array.isArray(tokens)) {
    throw providerUnavailable("Hastra proof-of-reserves feed listed no token metrics");
  }
  const primeEntries = tokens.filter((entry) => entry?.token === "prime");
  if (primeEntries.length !== 1) {
    throw providerUnavailable(
      `Hastra proof-of-reserves feed listed ${primeEntries.length} PRIME metric entries`
    );
  }

  return {
    providerReference,
    currentApy: hastraPercentToDecimalString(primeEntries[0]?.effective_rate),
    solanaTvlUsd: multiplyNonNegativeDecimals(
      body.prime_card?.vault_balance_by_chain?.solana,
      "PRIME Solana vault balance",
      body.wylds_card?.wylds_ratio,
      "wYLDS USD ratio"
    ),
  };
}
