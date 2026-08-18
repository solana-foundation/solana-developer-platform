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

/**
 * Alpha-2 codes a font will actually draw as a flag: the `RGI_Emoji_Flag_Sequence`
 * set from Unicode 17.0 emoji-sequences.txt. Unicode is the only authority here —
 * CLDR is not, because it aliases withdrawn ISO 3166-1 codes onto their successor
 * region ("AN" resolves to "Curaçao"), so a "does CLDR name it?" test passes codes
 * that have no flag sequence and the pair renders as two letter boxes.
 *
 * Regenerate when a region is added:
 *   curl -s https://unicode.org/Public/emoji/latest/emoji-sequences.txt |
 *     grep RGI_Emoji_Flag_Sequence
 */
const FLAG_EMOJI_REGIONS: ReadonlySet<string> = new Set(
  `AC AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
   BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
   CA CC CD CF CG CH CI CK CL CM CN CO CP CQ CR CU CV CW CX CY CZ
   DE DG DJ DK DM DO DZ
   EA EC EE EG EH ER ES ET EU
   FI FJ FK FM FO FR
   GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
   HK HM HN HR HT HU
   IC ID IE IL IM IN IO IQ IR IS IT
   JE JM JO JP
   KE KG KH KI KM KN KP KR KW KY KZ
   LA LB LC LI LK LR LS LT LU LV LY
   MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
   NA NC NE NF NG NI NL NO NP NR NU NZ
   OM
   PA PE PF PG PH PK PL PM PN PR PS PT PW PY
   QA
   RE RO RS RU RW
   SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
   TA TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
   UA UG UM UN US UY UZ
   VA VC VE VG VI VN VU
   WF WS
   XK
   YE YT
   ZA ZM ZW`.split(/\s+/)
);

/**
 * Flag emoji for an ISO 3166-1 alpha-2 region code — its two letters shifted
 * into the Unicode regional-indicator block, e.g. "MX" → 🇲🇽. Also covers the
 * exceptionally reserved "EU". Returns null for every code Unicode defines no
 * flag sequence for, so callers can fall back to plain text instead of tofu.
 */
export function regionFlagEmoji(code: string): string | null {
  const region = code.toUpperCase();
  if (!FLAG_EMOJI_REGIONS.has(region)) {
    return null;
  }
  return String.fromCodePoint(...[...region].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/**
 * Flag emoji for a fiat currency via its issuing region — the first two ISO
 * 4217 letters. Returns null for currencies without a national flag: ISO 4217
 * assigns supranational and commodity codes (XCD, XAU, …) the user-assigned
 * alpha-2 ranges, and CLDR pseudo-regions are excluded by the same rule.
 */
export function fiatCurrencyFlagEmoji(code: RampFiatCurrency): string | null {
  return regionFlagEmoji(code.slice(0, 2));
}
