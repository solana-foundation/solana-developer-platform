import { RAMP_EVENT_PROVIDERS, type RampEventProvider } from "@sdp/types";
import {
  CRYPTO_RAIL_ASSET_LABELS,
  type CryptoAssetSymbol,
  type CryptoRailId,
  type RampCountrySupport,
  type RampCurrencyLimit,
} from "@sdp/types/payment-rails";

let activeIso4217Currencies: Set<string> | undefined;
let countryDisplayNames: Intl.DisplayNames | undefined;

function getActiveIso4217Currencies(): Set<string> {
  if (activeIso4217Currencies === undefined) {
    activeIso4217Currencies = new Set(Intl.supportedValuesOf("currency"));
  }
  return activeIso4217Currencies;
}

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

export function isActiveIso4217CurrencyCode(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) && getActiveIso4217Currencies().has(normalized);
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
