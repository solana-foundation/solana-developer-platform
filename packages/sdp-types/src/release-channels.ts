/**
 * SDP release channels: which product modules a deployment can run at all.
 *
 * A release channel is a ceiling, not a rollout. A module outside the deployment's
 * release channel is off everywhere (API, background jobs, dashboard) whatever its
 * feature flag says; a module inside it behaves exactly as its flags decide.
 * Bringing a module back is a reviewed change to this file, never an env var.
 *
 * `SDP_RELEASE_CHANNEL` selects the release channel. Unset means `experimental`, today's behavior.
 */

import { z } from "zod";
import { RAMP_PROVIDERS, type RampProviderId } from "./provider-access";

export const SDP_MODULES = [
  "custody",
  "payments",
  "recurring_payments",
  "ramps",
  "compliance",
  "policies",
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
 * Ramps has no stage of its own: it is in a release channel when at least one
 * ramp provider is (`SDP_RAMP_PROVIDER_STAGES`), so providers launch one at a time.
 */
export const SDP_MODULE_STAGES = {
  custody: "stable",
  payments: "stable",
  recurring_payments: "stable",
  compliance: "stable",
  policies: "experimental",
  issuance: "experimental",
  markets: "experimental",
  earn: "experimental",
  dvp: "experimental",
  private_channels: "experimental",
  helius_rings: "experimental",
} as const satisfies Record<Exclude<SdpModule, "ramps">, SdpReleaseChannel>;

/** Each ramp provider's maturity. Promoting a provider is a one-line change here. */
export const SDP_RAMP_PROVIDER_STAGES = {
  moonpay: "experimental",
  lightspark: "experimental",
  bvnk: "experimental",
  moneygram: "experimental",
  coinbase: "experimental",
  mural: "experimental",
  stripe: "experimental",
} as const satisfies Record<RampProviderId, SdpReleaseChannel>;

export const DEFAULT_SDP_RELEASE_CHANNEL: SdpReleaseChannel = "experimental";

const sdpReleaseChannelSchema = z.enum(SDP_RELEASE_CHANNEL_NAMES);

/**
 * Resolves `SDP_RELEASE_CHANNEL`. Unset or blank is the documented `experimental` default.
 * Throws on an unknown name so a typo fails at boot instead of silently
 * running every module.
 */
export function resolveSdpReleaseChannel(value: string | undefined): SdpReleaseChannel {
  const name = value?.trim();
  if (!name) {
    return DEFAULT_SDP_RELEASE_CHANNEL;
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

function isStageInReleaseChannel(stage: SdpReleaseChannel, releaseChannel: SdpReleaseChannel) {
  return maturity(stage) >= maturity(releaseChannel);
}

export function isRampProviderInReleaseChannel(
  releaseChannel: SdpReleaseChannel,
  provider: RampProviderId,
  stages: Record<RampProviderId, SdpReleaseChannel> = SDP_RAMP_PROVIDER_STAGES
): boolean {
  return isStageInReleaseChannel(stages[provider], releaseChannel);
}

export function isModuleInReleaseChannel(
  releaseChannel: SdpReleaseChannel,
  module: SdpModule,
  rampProviderStages: Record<RampProviderId, SdpReleaseChannel> = SDP_RAMP_PROVIDER_STAGES
): boolean {
  if (module === "ramps") {
    return RAMP_PROVIDERS.some((provider) =>
      isRampProviderInReleaseChannel(releaseChannel, provider, rampProviderStages)
    );
  }
  return isStageInReleaseChannel(SDP_MODULE_STAGES[module], releaseChannel);
}

function modulesInReleaseChannel(releaseChannel: SdpReleaseChannel): readonly SdpModule[] {
  return SDP_MODULES.filter((module) => isModuleInReleaseChannel(releaseChannel, module));
}

/** Each release channel's modules, derived from `SDP_MODULE_STAGES`. */
export const SDP_RELEASE_CHANNELS = {
  experimental: modulesInReleaseChannel("experimental"),
  beta: modulesInReleaseChannel("beta"),
  stable: modulesInReleaseChannel("stable"),
} as const satisfies Record<SdpReleaseChannel, readonly SdpModule[]>;
