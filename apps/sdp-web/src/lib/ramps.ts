import type { SdpEnvironment } from "@sdp/types/api-keys";
import { OFFRAMP_SUPPORT, ONRAMP_SUPPORT, type RampFiatCurrency } from "@sdp/types/generated/ramp";
import { type CryptoRailId, cryptoRailMint } from "@sdp/types/payment-rails";
import type { PersistedRampProviderId, RampProviderId } from "@sdp/types/provider-access";
import { isRampProviderSurfaced, isRetiredRampProviderId } from "@sdp/types/provider-access";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";

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
  stripe: "/provider-logos/stripe.svg",
  hercle: "/provider-logos/hercle.png",
} as const satisfies Record<RampProviderId, string>;

export const RAMP_PROVIDER_WEBSITES = {
  moonpay: "https://www.moonpay.com",
  stripe: "https://stripe.com",
  hercle: "https://www.hercle.financial",
} as const satisfies Record<RampProviderId, string>;

export const RAMP_PROVIDER_OPTIONS: RampProviderOption[] = [
  { id: "moonpay", title: "MoonPay" },
  { id: "stripe", title: "Stripe" },
  { id: "hercle", title: "Hercle" },
];

/**
 * Whether the API settles a provider's sandbox on-ramp on request (`POST /v1/payments/ramps/sandbox/simulate`).
 * Hercle settles its sandbox orders only this way; the API refuses the others.
 */
export const RAMP_PROVIDER_SANDBOX_SETTLEMENT = {
  moonpay: false,
  stripe: false,
  hercle: true,
} as const satisfies Record<RampProviderId, boolean>;

/**
 * Whether a deposit through `provider` can be marked paid outside the demo.
 * It needs a sandbox project, a provider the channel-capped flags offer, and one the API settles on request.
 *
 * @param provider - The provider the deposit was quoted with.
 * @param environment - The project's environment.
 * @param enabledProviders - The providers enabled for the current request.
 * @returns Whether the sandbox settlement action is offered.
 */
export function offersSandboxSettlement(
  provider: RampProviderId,
  environment: SdpEnvironment,
  enabledProviders: readonly RampProviderId[]
): boolean {
  return (
    environment === "sandbox" &&
    enabledProviders.includes(provider) &&
    RAMP_PROVIDER_SANDBOX_SETTLEMENT[provider]
  );
}

/**
 * Returns the ramp providers surfaced for an environment and enabled by feature flags.
 *
 * @param environment - The dashboard environment.
 * @param enabledProviders - The providers enabled for the current request.
 * @returns The selectable provider options.
 */
export function surfacedRampProviderOptions(
  environment: SdpEnvironment,
  enabledProviders: readonly RampProviderId[]
): RampProviderOption[] {
  return RAMP_PROVIDER_OPTIONS.filter(
    (option) =>
      isRampProviderSurfaced(option.id, environment) && enabledProviders.includes(option.id)
  );
}

/**
 * The surfaced, enabled providers a pair on `assetRail` is offered with, and none on a rail with no mint on the cluster.
 * The API refuses a quote for such a rail (USDT on devnet) and lists no pair for it.
 */
function offeredPairProviders(
  assetRail: CryptoRailId,
  providers: readonly RampProviderId[],
  environment: SdpEnvironment,
  enabledProviders: readonly RampProviderId[]
): RampProviderId[] {
  if (cryptoRailMint(assetRail, CLUSTER_BY_SDP_ENVIRONMENT[environment]) === undefined) return [];
  return providers.filter(
    (provider) =>
      isRampProviderSurfaced(provider, environment) && enabledProviders.includes(provider)
  );
}

/**
 * Returns on-ramp currency pairs with only surfaced and enabled providers.
 *
 * @param environment - The dashboard environment.
 * @param enabledProviders - The providers enabled for the current request.
 * @returns The available on-ramp pairs.
 */
export function onrampPairs(
  environment: SdpEnvironment,
  enabledProviders: readonly RampProviderId[]
): RampPair[] {
  return ONRAMP_SUPPORT.flatMap(({ source, dest, providers }) => {
    const surfaced = offeredPairProviders(dest, providers, environment, enabledProviders);
    if (surfaced.length === 0) return [];
    return [{ fiatCurrency: source, assetRail: dest, providers: surfaced }];
  });
}

// Offramp support is keyed crypto -> fiat (source is the asset rail, dest is the fiat
// currency), the reverse of onramp. Normalize into the same RampPair shape.
/**
 * Returns off-ramp currency pairs with only surfaced and enabled providers.
 *
 * @param environment - The dashboard environment.
 * @param enabledProviders - The providers enabled for the current request.
 * @returns The available off-ramp pairs.
 */
export function offrampPairs(
  environment: SdpEnvironment,
  enabledProviders: readonly RampProviderId[]
): RampPair[] {
  return OFFRAMP_SUPPORT.flatMap(({ source, dest, providers }) => {
    const surfaced = offeredPairProviders(source, providers, environment, enabledProviders);
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

export function getRampProviderLabel(provider: PersistedRampProviderId): string {
  return (
    RAMP_PROVIDER_OPTIONS.find((option) => option.id === provider)?.title ??
    (provider.length <= 4
      ? provider.toUpperCase()
      : provider.charAt(0).toUpperCase() + provider.slice(1))
  );
}

/** A retired provider has no logo; its stored rows render with the label alone. */
export function getRampProviderLogo(provider: PersistedRampProviderId): string | undefined {
  return isRetiredRampProviderId(provider) ? undefined : RAMP_PROVIDER_LOGOS[provider];
}
