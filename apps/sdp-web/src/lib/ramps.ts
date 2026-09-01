import type { SdpEnvironment } from "@sdp/types";
import { OFFRAMP_SUPPORT, ONRAMP_SUPPORT, type RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import { isRampProviderSurfaced, type RampProviderId } from "@sdp/types/provider-access";

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
  moneygram: "/provider-logos/moneygram.svg",
  coinbase: "/provider-logos/coinbase-cdp.png",
  mural: "/provider-logos/muralpay.svg",
  stripe: "/provider-logos/stripe.svg",
} as const satisfies Record<RampProviderId, string>;

export const RAMP_PROVIDER_WEBSITES = {
  moonpay: "https://www.moonpay.com",
  lightspark: "https://www.lightspark.com",
  bvnk: "https://www.bvnk.com",
  moneygram: "https://www.moneygram.com",
  coinbase: "https://www.coinbase.com/developer-platform",
  mural: "https://www.muralpay.com",
  stripe: "https://stripe.com",
} as const satisfies Record<RampProviderId, string>;

export const RAMP_PROVIDER_OPTIONS: RampProviderOption[] = [
  { id: "moonpay", title: "MoonPay" },
  { id: "lightspark", title: "Lightspark" },
  { id: "bvnk", title: "BVNK" },
  { id: "moneygram", title: "MoneyGram" },
  { id: "coinbase", title: "Coinbase" },
  { id: "mural", title: "Mural Pay" },
  { id: "stripe", title: "Stripe" },
];

export function surfacedRampProviderOptions(environment: SdpEnvironment): RampProviderOption[] {
  return RAMP_PROVIDER_OPTIONS.filter((option) => isRampProviderSurfaced(option.id, environment));
}

export function onrampPairs(environment: SdpEnvironment): RampPair[] {
  return ONRAMP_SUPPORT.flatMap(({ source, dest, providers }) => {
    const surfaced = providers.filter((p) => isRampProviderSurfaced(p, environment));
    if (surfaced.length === 0) return [];
    return [{ fiatCurrency: source, assetRail: dest, providers: surfaced }];
  });
}

// Offramp support is keyed crypto -> fiat (source is the asset rail, dest is the fiat
// currency), the reverse of onramp. Normalize into the same RampPair shape.
export function offrampPairs(environment: SdpEnvironment): RampPair[] {
  return OFFRAMP_SUPPORT.flatMap(({ source, dest, providers }) => {
    const surfaced = providers.filter((p) => isRampProviderSurfaced(p, environment));
    if (surfaced.length === 0) return [];
    return [{ fiatCurrency: dest, assetRail: source, providers: surfaced }];
  });
}

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
