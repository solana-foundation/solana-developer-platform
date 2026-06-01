import { ONRAMP_SUPPORT, type RampFiatCurrency } from "@sdp/types/generated/ramp-support";
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
