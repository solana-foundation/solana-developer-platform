import type { RampProviderId } from "./provider-access";

export type FiatCurrencyCode = string;

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

export const CRYPTO_RAIL_ASSET_LABELS = {
  "sol.solana": "SOL",
  "usdc.solana": "USDC",
  "usdt.solana": "USDT",
  "usdg.solana": "USDG",
  "pyusd.solana": "PYUSD",
} as const satisfies Record<CryptoRailId, string>;

export function getCryptoRailAssetLabel(assetRail: CryptoRailId): string {
  return CRYPTO_RAIL_ASSET_LABELS[assetRail];
}

export type CryptoAssetSymbol = (typeof CRYPTO_RAIL_ASSET_LABELS)[CryptoRailId];

/** On-chain decimals per crypto asset symbol; fiat falls back to 2 minor units. */
export const CRYPTO_ASSET_DECIMALS = {
  SOL: 9,
  USDC: 6,
  USDT: 6,
  USDG: 6,
  PYUSD: 6,
} as const satisfies Record<CryptoAssetSymbol, number>;

export interface OnrampPairSupport<FiatCurrency extends string = FiatCurrencyCode> {
  source: FiatCurrency;
  dest: CryptoRailId;
  providers: readonly RampProviderId[];
}

export interface OfframpPairSupport<FiatCurrency extends string = FiatCurrencyCode> {
  source: CryptoRailId;
  dest: FiatCurrency;
  providers: readonly RampProviderId[];
}

export function parseFiatCurrency(value: string): FiatCurrencyCode | null {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    return null;
  }

  return normalized;
}
