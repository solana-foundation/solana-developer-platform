import { RAMP_EVENT_PROVIDERS, type RampEventProvider } from "@sdp/types";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import type { MutableProviderRampSupport } from "./types";

export function isRampEventProvider(value: string | undefined): value is RampEventProvider {
  return value !== undefined && (RAMP_EVENT_PROVIDERS as readonly string[]).includes(value);
}

export const SOLANA_CRYPTO_ASSETS = ["SOL", "USDC", "USDT", "USDG", "PYUSD"] as const;
export type SolanaCryptoAsset = (typeof SOLANA_CRYPTO_ASSETS)[number];

export const SOLANA_ASSET_TO_RAIL = {
  SOL: "sol.solana",
  USDC: "usdc.solana",
  USDT: "usdt.solana",
  USDG: "usdg.solana",
  PYUSD: "pyusd.solana",
} as const satisfies Record<SolanaCryptoAsset, CryptoRailId>;

export function isSolanaCryptoAsset(value: string): value is SolanaCryptoAsset {
  return (SOLANA_CRYPTO_ASSETS as readonly string[]).includes(value);
}

export function createProviderRampSupport(): MutableProviderRampSupport {
  return {
    onrampFiats: new Set(),
    onrampCryptos: new Set(),
    offrampFiats: new Set(),
    offrampCryptos: new Set(),
  };
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
} as const;
