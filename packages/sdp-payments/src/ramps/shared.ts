import { RAMP_EVENT_PROVIDERS, type RampEventProvider } from "@sdp/types";
import {
  CRYPTO_RAIL_ASSET_LABELS,
  type CryptoAssetSymbol,
  type CryptoRailId,
  type RampCountrySupport,
  type RampCurrencyLimit,
} from "@sdp/types/payment-rails";

let icuModernCurrencies: Set<string> | undefined;
let countryDisplayNames: Intl.DisplayNames | undefined;

function getIcuModernCurrencies(): Set<string> {
  if (icuModernCurrencies === undefined) {
    icuModernCurrencies = new Set(Intl.supportedValuesOf("currency"));
  }
  return icuModernCurrencies;
}

/**
 * Codes ICU still reports as modern currencies that no region tenders any more.
 * `Intl.supportedValuesOf("currency")` answers "does CLDR carry this code", not
 * "is this money" — it keeps a code for years past withdrawal — which is how
 * currencies nobody can transact reached the pickers.
 *
 * Dates are when the last issuing region stopped tendering, per CLDR
 * supplemental currencyData: cldr-json/cldr-core/supplemental/currencyData.json.
 * Recheck after an ICU bump — a code is dead there when every region entry for
 * it carries a `_to` date or is marked non-tender.
 */
const RETIRED_ISO_4217_CODES: ReadonlySet<string> = new Set([
  "ANG", // to 2025-06-30 - Netherlands Antillean guilder, succeeded by XCG
  "BGN", // to 2026-01-31 - Bulgarian lev, succeeded by EUR
  "CUC", // to 2021-06-01 - Cuban convertible peso, succeeded by CUP
  "HRK", // to 2023-01-14 - Croatian kuna, succeeded by EUR
  "SLL", // to 2023-12-31 - Sierra Leonean leone, redenominated as SLE
  "SVC", // to 2001-01-01 - Salvadoran colon, succeeded by USD
  "ZWL", // to 2024-08-31 - Zimbabwean dollar, succeeded by ZWG
  "XDR", // non-tender - IMF special drawing rights
  "XSU", // non-tender - ALBA sucre, unit of account only
]);

function getCountryDisplayNames(): Intl.DisplayNames {
  if (countryDisplayNames === undefined) {
    countryDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });
  }
  return countryDisplayNames;
}

export function isRampEventProvider(value: string | undefined): value is RampEventProvider {
  return value !== undefined && (RAMP_EVENT_PROVIDERS as readonly string[]).includes(value);
}

export type SolanaCryptoAsset = CryptoAssetSymbol;

export const SOLANA_ASSET_TO_RAIL = Object.fromEntries(
  Object.entries(CRYPTO_RAIL_ASSET_LABELS).map(([rail, asset]) => [asset, rail])
) as Record<SolanaCryptoAsset, CryptoRailId>;

export function isSolanaCryptoAsset(value: string): value is SolanaCryptoAsset {
  return value in SOLANA_ASSET_TO_RAIL;
}

export function unreportedCurrencyLimit(): RampCurrencyLimit {
  return { min: null, max: null };
}

export const UNREPORTED_COUNTRY_SUPPORT = {
  coverage: "unreported",
} as const satisfies RampCountrySupport;

/** True only for currencies a counterparty can still be paid in today. */
export function isActiveIso4217CurrencyCode(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return (
    /^[A-Z]{3}$/.test(normalized) &&
    !RETIRED_ISO_4217_CODES.has(normalized) &&
    getIcuModernCurrencies().has(normalized)
  );
}

export function isIso3166Alpha2CountryCode(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return false;
  }
  const displayName = getCountryDisplayNames().of(normalized);
  return displayName !== undefined && displayName !== normalized;
}

export function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${key}.`);
  }
  return value;
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${globalThis.btoa(`${username}:${password}`)}`;
}

export function rampId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function dumpFile<TName extends string>(name: TName): `${TName}.json` {
  return `${name}.json`;
}

export const RAMP_RAIL_DUMPS = {
  moonpay: {
    currencies: { name: "moonpay/currencies", file: dumpFile("moonpay/currencies") },
    countries: { name: "moonpay/countries", file: dumpFile("moonpay/countries") },
  },
  lightspark: {
    config: { name: "lightspark/config", file: dumpFile("lightspark/config") },
  },
  bvnk: {
    cryptoAnon: { name: "bvnk/crypto__anon", file: dumpFile("bvnk/crypto__anon") },
    fiatAnon: { name: "bvnk/fiat__anon", file: dumpFile("bvnk/fiat__anon") },
    depositAnon: { name: "bvnk/deposit__anon", file: dumpFile("bvnk/deposit__anon") },
  },
  moneygram: {
    currencies: { name: "moneygram/currencies", file: dumpFile("moneygram/currencies") },
  },
  coinbase: {
    buyOptions: {
      name: "coinbase/buy_options",
      file: dumpFile("coinbase/buy_options"),
    },
  },
  mural: {
    countries: { name: "mural/countries", file: dumpFile("mural/countries") },
  },
} as const;
