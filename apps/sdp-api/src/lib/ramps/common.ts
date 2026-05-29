import type { CryptoRailId } from "@sdp/types/payment-rails";
import type { MutableProviderRampSupport } from "./types";

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
