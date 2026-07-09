import type { CounterpartyEntityType } from "./counterparties";
import type { RampFiatCurrency } from "./generated/ramp-support.generated";
import type { RampProviderId } from "./provider-access";

export const SOLANA_CRYPTO_RAILS = [
  "sol.solana",
  "usdc.solana",
  "usdt.solana",
  "usdg.solana",
  "pyusd.solana",
] as const;

export const ONRAMP_CRYPTO_RAILS = SOLANA_CRYPTO_RAILS;
export const OFFRAMP_CRYPTO_RAILS = SOLANA_CRYPTO_RAILS;

export type CryptoRailId = (typeof SOLANA_CRYPTO_RAILS)[number];
type CryptoRailNetworkFromRail<TRail extends CryptoRailId> =
  TRail extends `${string}.${infer Network}` ? Uppercase<Network> : never;
export type CryptoRailNetwork = CryptoRailNetworkFromRail<CryptoRailId>;

export const CRYPTO_RAIL_ASSET_LABELS = {
  "sol.solana": "SOL",
  "usdc.solana": "USDC",
  "usdt.solana": "USDT",
  "usdg.solana": "USDG",
  "pyusd.solana": "PYUSD",
} as const satisfies Record<CryptoRailId, string>;

export type CryptoAssetSymbol = (typeof CRYPTO_RAIL_ASSET_LABELS)[CryptoRailId];

export function getCryptoRailAssetLabel(assetRail: CryptoRailId): CryptoAssetSymbol {
  return CRYPTO_RAIL_ASSET_LABELS[assetRail];
}

export interface OnrampPairSupport<FiatCurrency extends RampFiatCurrency = RampFiatCurrency> {
  source: FiatCurrency;
  dest: CryptoRailId;
  providers: readonly RampProviderId[];
}

export interface OfframpPairSupport<FiatCurrency extends RampFiatCurrency = RampFiatCurrency> {
  source: CryptoRailId;
  dest: FiatCurrency;
  providers: readonly RampProviderId[];
}

export type RampCountrySupport =
  | { coverage: "by-country"; countries: Readonly<Record<string, readonly string[]>> }
  | { coverage: "all-currencies"; countries: readonly string[] }
  | { coverage: "unreported" };

/** Returns reported provider coverage for a country/currency corridor. */
export function rampProviderServesCountry(
  support: RampCountrySupport,
  country: string,
  currency: string
): boolean | "unknown" {
  switch (support.coverage) {
    case "by-country": {
      const supportedCurrencies = support.countries[country];
      return supportedCurrencies?.includes(currency) === true;
    }
    case "all-currencies":
      return support.countries.includes(country);
    case "unreported":
      return "unknown";
    default: {
      const exhaustive: never = support;
      return exhaustive;
    }
  }
}

export interface RampCurrencyLimit {
  min: string | null;
  max: string | null;
}

export interface RampProviderDirectionSupport {
  currencies: Readonly<Record<string, RampCurrencyLimit>>;
  countrySupport: RampCountrySupport;
  entityTypes: readonly CounterpartyEntityType[];
}

let fiatDisplayNames: Intl.DisplayNames | undefined;
let countryDisplayNamesInstance: Intl.DisplayNames | undefined;

function getFiatDisplayNames(): Intl.DisplayNames {
  if (fiatDisplayNames === undefined) {
    fiatDisplayNames = new Intl.DisplayNames(["en"], { type: "currency" });
  }
  return fiatDisplayNames;
}

function getCountryDisplayNames(): Intl.DisplayNames {
  if (countryDisplayNamesInstance === undefined) {
    countryDisplayNamesInstance = new Intl.DisplayNames(["en"], { type: "region" });
  }
  return countryDisplayNamesInstance;
}

/** CLDR English name for a supported fiat currency, e.g. "MXN" → "Mexican Peso". */
export function fiatCurrencyDisplayName(code: RampFiatCurrency): string {
  const displayName = getFiatDisplayNames().of(code);
  if (displayName === undefined) {
    throw new Error(`Intl.DisplayNames did not return a currency name for ${code}.`);
  }
  return displayName;
}

/**
 * CLDR English name for an ISO 3166-1 alpha-2 country code, e.g. "MX" → "Mexico".
 * Accepts any alpha-2 string, not just RampCountryCode — callers pass
 * counterparty countries, which are not limited to regions a provider serves.
 */
export function countryDisplayName(code: string): string {
  const displayName = getCountryDisplayNames().of(code);
  if (displayName === undefined) {
    throw new Error(`Intl.DisplayNames did not return a country name for ${code}.`);
  }
  return displayName;
}

const ISO_3166_USER_ASSIGNED_ALPHA2 = /^(AA|Q[M-Z]|X[A-Z]|ZZ)$/;

/**
 * Flag emoji for a fiat currency via its issuing region — the first two ISO
 * 4217 letters, shifted into the Unicode regional-indicator block. Returns
 * null for currencies without a national flag: ISO 4217 assigns supranational
 * and commodity codes (XCD, XAU, …) the user-assigned alpha-2 ranges, and
 * CLDR pseudo-regions are excluded by the same rule.
 */
export function fiatCurrencyFlagEmoji(code: RampFiatCurrency): string | null {
  const region = code.slice(0, 2);
  if (
    ISO_3166_USER_ASSIGNED_ALPHA2.test(region) ||
    getCountryDisplayNames().of(region) === region
  ) {
    return null;
  }
  return String.fromCodePoint(...[...region].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
