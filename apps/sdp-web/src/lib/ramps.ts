import {
  OFFRAMP_SUPPORT,
  ONRAMP_SUPPORT,
  type RampFiatCurrency,
} from "@sdp/types/generated/ramp-support";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import type { RampProviderId } from "@sdp/types/provider-access";

export type RampDirection = "onramp" | "offramp";

export type RampPair = {
  fiatCurrency: RampFiatCurrency;
  assetRail: CryptoRailId;
  providers: readonly RampProviderId[];
};

export type SelectedRampPair = {
  fiatCurrency: RampFiatCurrency;
  assetRail: CryptoRailId;
};

export type RampProviderOption = {
  id: RampProviderId;
  title: string;
};

export const RAMP_PROVIDER_LOGOS = {
  moonpay: "/provider-logos/moonpay.svg",
  lightspark: "/provider-logos/lightspark.svg",
  bvnk: "/provider-logos/bvnk.svg",
} as const satisfies Record<RampProviderId, string>;

export const RAMP_PROVIDER_OPTIONS: RampProviderOption[] = [
  { id: "moonpay", title: "MoonPay" },
  { id: "lightspark", title: "Lightspark" },
  { id: "bvnk", title: "BVNK" },
];

export const ONRAMP_PAIRS: RampPair[] = ONRAMP_SUPPORT.map(({ source, dest, providers }) => ({
  fiatCurrency: source,
  assetRail: dest,
  providers,
}));

// Offramp support is keyed crypto -> fiat (source is the asset rail, dest is the fiat
// currency), the reverse of onramp. Normalize into the same RampPair shape.
export const OFFRAMP_PAIRS: RampPair[] = OFFRAMP_SUPPORT.map(({ source, dest, providers }) => ({
  fiatCurrency: dest,
  assetRail: source,
  providers,
}));

export const DEFAULT_RAMP_PAIR: SelectedRampPair = {
  fiatCurrency: "USD",
  assetRail: "usdc.solana",
};

export function findRampPair(
  pairs: readonly RampPair[],
  selectedPair: SelectedRampPair
): RampPair | null {
  return (
    pairs.find(
      (pair) =>
        pair.fiatCurrency === selectedPair.fiatCurrency && pair.assetRail === selectedPair.assetRail
    ) ?? null
  );
}

export function rampPairKey(pair: SelectedRampPair): string {
  return `${pair.fiatCurrency}:${pair.assetRail}`;
}

export function toRampCryptoToken(assetRail: SelectedRampPair["assetRail"]): string {
  return assetRail.split(".")[0]?.toUpperCase() ?? assetRail.toUpperCase();
}

export function getRampProviderLabel(provider: RampProviderId): string {
  return RAMP_PROVIDER_OPTIONS.find((option) => option.id === provider)?.title ?? provider;
}

export function resolveDefaultRampPair(
  pairs: readonly RampPair[],
  preferredPair: SelectedRampPair = { fiatCurrency: "USD", assetRail: "usdc.solana" }
): SelectedRampPair {
  const preferred = findRampPair(pairs, preferredPair);
  const fallback = preferred ?? pairs[0];

  return {
    fiatCurrency: fallback?.fiatCurrency ?? preferredPair.fiatCurrency,
    assetRail: fallback?.assetRail ?? preferredPair.assetRail,
  };
}
