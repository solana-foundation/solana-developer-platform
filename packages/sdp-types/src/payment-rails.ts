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
