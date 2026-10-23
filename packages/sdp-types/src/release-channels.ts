/**
 * SDP release channels: which product modules a deployment can run at all.
 *
 * A release channel is a ceiling, not a rollout. A module outside the deployment's
 * release channel is off everywhere (API, background jobs, dashboard) whatever its
 * feature flag says; a module inside it behaves exactly as its flags decide.
 * Bringing a module back is a reviewed change to this file, never an env var.
 *
 * `SDP_RELEASE_CHANNEL` selects the release channel. It is required: a missing value
 * fails at boot rather than running every module.
 */

import { z } from "zod";
import {
  BYOK_CUSTODY_PROVIDERS,
  type ByokCustodyProvider,
  CUSTODY_PROVIDERS,
  type CustodyMode,
  type CustodyProvider,
  isByokCustodyProvider,
} from "./custody";
import { RAMP_PROVIDERS, type RampProviderId } from "./provider-access";

export const SDP_MODULES = [
  "custody",
  "payments",
  "recurring_payments",
  "ramps",
  "compliance",
  "issuance",
  "markets",
  "earn",
  "dvp",
  "private_channels",
  "helius_rings",
] as const;

export type SdpModule = (typeof SDP_MODULES)[number];

/** Ordered from least to most mature. */
export const SDP_RELEASE_CHANNEL_NAMES = ["experimental", "beta", "stable"] as const;

export type SdpReleaseChannel = (typeof SDP_RELEASE_CHANNEL_NAMES)[number];

/**
 * Each module's maturity. A release channel runs every module at or above its
 * own level, so each channel contains the more mature ones by construction.
 * Promoting a module is a one-line change here.
 *
 * Three modules have no maturity of their own:
 * - Custody is in a release channel when at least one (provider, custody mode)
 *   pair is (`SDP_MANAGED_CUSTODY_PROVIDER_MATURITY`, `SDP_BYOK_CUSTODY_PROVIDER_MATURITY`),
 *   so pairs launch one at a time.
 * - Ramps is in a release channel when at least one ramp provider is
 *   (`SDP_RAMP_PROVIDER_MATURITY`), so providers launch one at a time.
 * - Markets is in a release channel when Earn or DvP is, so promoting one
 *   sub-module always takes effect.
 */
export const SDP_MODULE_MATURITY = {
  payments: "stable",
  recurring_payments: "stable",
  compliance: "experimental",
  issuance: "experimental",
  earn: "beta",
  dvp: "experimental",
  private_channels: "experimental",
  helius_rings: "experimental",
} as const satisfies Record<Exclude<SdpModule, "custody" | "ramps" | "markets">, SdpReleaseChannel>;

/**
 * Each custody provider's maturity, per custody mode. Promoting a (provider, mode)
 * pair is a one-line change here.
 */
export const SDP_MANAGED_CUSTODY_PROVIDER_MATURITY = {
  local: "beta",
  fireblocks: "beta",
  privy: "stable",
  coinbase_cdp: "beta",
  para: "beta",
  turnkey: "beta",
  dfns: "beta",
  ibm_haven: "beta",
  anchorage: "beta",
  utila: "beta",
} as const satisfies Record<CustodyProvider, SdpReleaseChannel>;

export const SDP_BYOK_CUSTODY_PROVIDER_MATURITY = {
  privy: "stable",
  fireblocks: "beta",
} as const satisfies Record<ByokCustodyProvider, SdpReleaseChannel>;

export type SdpRampProviderMaturity = Record<RampProviderId, SdpReleaseChannel>;

/** Each ramp provider's maturity. Promoting a provider is a one-line change here. */
export const SDP_RAMP_PROVIDER_MATURITY = {
  moonpay: "experimental",
  stripe: "experimental",
} as const satisfies SdpRampProviderMaturity;

const sdpReleaseChannelSchema = z.enum(SDP_RELEASE_CHANNEL_NAMES);

/**
 * Resolves `SDP_RELEASE_CHANNEL`. Throws when it is missing or unknown, so a forgotten
 * variable or a typo fails at boot instead of silently running every module.
 */
export function resolveSdpReleaseChannel(value: string | undefined): SdpReleaseChannel {
  const name = value?.trim();
  if (!name) {
    throw new Error(
      `SDP_RELEASE_CHANNEL is required (one of ${SDP_RELEASE_CHANNEL_NAMES.join(", ")})`
    );
  }
  const parsed = sdpReleaseChannelSchema.safeParse(name);
  if (!parsed.success) {
    throw new Error(
      `SDP_RELEASE_CHANNEL must be one of ${SDP_RELEASE_CHANNEL_NAMES.join(", ")}; got "${name}"`
    );
  }
  return parsed.data;
}

function maturity(releaseChannel: SdpReleaseChannel): number {
  return SDP_RELEASE_CHANNEL_NAMES.indexOf(releaseChannel);
}

function isMaturityInReleaseChannel(level: SdpReleaseChannel, releaseChannel: SdpReleaseChannel) {
  return maturity(level) >= maturity(releaseChannel);
}

/**
 * @param rampProviderMaturity - `SDP_RAMP_PROVIDER_MATURITY`; tests pass their own table.
 */
export function isRampProviderInReleaseChannel(
  releaseChannel: SdpReleaseChannel,
  provider: RampProviderId,
  rampProviderMaturity: SdpRampProviderMaturity
): boolean {
  return isMaturityInReleaseChannel(rampProviderMaturity[provider], releaseChannel);
}

/**
 * Whether the release channel offers custody `provider` in `mode`, from
 * `SDP_MANAGED_CUSTODY_PROVIDER_MATURITY` and `SDP_BYOK_CUSTODY_PROVIDER_MATURITY`.
 * A `byok` pair whose provider has no BYOK runtime is in no channel.
 *
 * @param releaseChannel - The deployment's release channel.
 * @param provider - The custody provider.
 * @param mode - The custody mode the provider is used in.
 * @returns True when the pair's maturity is at or above the release channel.
 */
export function isCustodyProviderInReleaseChannel(
  releaseChannel: SdpReleaseChannel,
  provider: CustodyProvider,
  mode: CustodyMode
): boolean {
  switch (mode) {
    case "managed":
      return isMaturityInReleaseChannel(
        SDP_MANAGED_CUSTODY_PROVIDER_MATURITY[provider],
        releaseChannel
      );
    case "byok":
      return (
        isByokCustodyProvider(provider) &&
        isMaturityInReleaseChannel(SDP_BYOK_CUSTODY_PROVIDER_MATURITY[provider], releaseChannel)
      );
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown custody mode: ${String(exhaustive)}`);
    }
  }
}

/**
 * @param rampProviderMaturity - `SDP_RAMP_PROVIDER_MATURITY`; tests pass their own table.
 */
export function isModuleInReleaseChannel(
  releaseChannel: SdpReleaseChannel,
  module: SdpModule,
  rampProviderMaturity: SdpRampProviderMaturity
): boolean {
  if (module === "custody") {
    return (
      CUSTODY_PROVIDERS.some((provider) =>
        isCustodyProviderInReleaseChannel(releaseChannel, provider, "managed")
      ) ||
      BYOK_CUSTODY_PROVIDERS.some((provider) =>
        isCustodyProviderInReleaseChannel(releaseChannel, provider, "byok")
      )
    );
  }
  if (module === "ramps") {
    return RAMP_PROVIDERS.some((provider) =>
      isRampProviderInReleaseChannel(releaseChannel, provider, rampProviderMaturity)
    );
  }
  if (module === "markets") {
    return (
      isModuleInReleaseChannel(releaseChannel, "earn", rampProviderMaturity) ||
      isModuleInReleaseChannel(releaseChannel, "dvp", rampProviderMaturity)
    );
  }
  return isMaturityInReleaseChannel(SDP_MODULE_MATURITY[module], releaseChannel);
}

function modulesInReleaseChannel(releaseChannel: SdpReleaseChannel): readonly SdpModule[] {
  return SDP_MODULES.filter((module) =>
    isModuleInReleaseChannel(releaseChannel, module, SDP_RAMP_PROVIDER_MATURITY)
  );
}

/** Each release channel's modules, derived from the module and provider maturity. */
export const SDP_RELEASE_CHANNELS = {
  experimental: modulesInReleaseChannel("experimental"),
  beta: modulesInReleaseChannel("beta"),
  stable: modulesInReleaseChannel("stable"),
} as const satisfies Record<SdpReleaseChannel, readonly SdpModule[]>;
