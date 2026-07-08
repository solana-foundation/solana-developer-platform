import { RAMP_FIAT_CURRENCIES, type RampFiatCurrency } from "./generated/ramp-support.generated";
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

export function parseFiatCurrency(value: string): RampFiatCurrency | null {
  const normalized = value.trim().toUpperCase();
  if (!RAMP_FIAT_CURRENCIES.includes(normalized as RampFiatCurrency)) {
    return null;
  }

  return normalized as RampFiatCurrency;
}
