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
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "./api-keys";
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

/** A module's maturity in each SDP environment (Sandbox on devnet, Production on mainnet). */
export type SdpEnvironmentMaturity = Readonly<Record<SdpEnvironment, SdpReleaseChannel>>;

/**
 * Each module's maturity per environment. A release channel runs a module for an
 * environment's projects when that environment's maturity is at or above the channel's
 * level, so each channel contains the more mature ones by construction. Deployment-wide
 * readers (jobs, flags, the public surface) count a module in when either environment
 * is; the API's project context refuses a project whose environment is not.
 * Promoting a module, or one environment of it, is a one-line change here.
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
  payments: { sandbox: "stable", production: "stable" },
  recurring_payments: { sandbox: "stable", production: "stable" },
  compliance: { sandbox: "experimental", production: "experimental" },
  issuance: { sandbox: "experimental", production: "experimental" },
  earn: { sandbox: "beta", production: "beta" },
  dvp: { sandbox: "experimental", production: "experimental" },
  private_channels: { sandbox: "experimental", production: "experimental" },
  helius_rings: { sandbox: "experimental", production: "experimental" },
} as const satisfies Record<
  Exclude<SdpModule, "custody" | "ramps" | "markets">,
  SdpEnvironmentMaturity
>;

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
  return SDP_ENVIRONMENTS.some((environment) =>
    isMaturityInReleaseChannel(SDP_MODULE_MATURITY[module][environment], releaseChannel)
  );
}

/**
 * Whether the release channel runs `module` for projects in `environment`. Custody and
 * ramps carry no per-environment maturity, so they answer as `isModuleInReleaseChannel`;
 * Markets is in when Earn or DvP is for the environment.
 *
 * @param releaseChannel - The deployment's release channel.
 * @param module - The module the request belongs to.
 * @param environment - The project's environment.
 * @param rampProviderMaturity - `SDP_RAMP_PROVIDER_MATURITY`; tests pass their own table.
 * @returns True when the channel runs the module for that environment.
 */
export function isModuleInReleaseChannelForEnvironment(
  releaseChannel: SdpReleaseChannel,
  module: SdpModule,
  environment: SdpEnvironment,
  rampProviderMaturity: SdpRampProviderMaturity
): boolean {
  if (module === "custody" || module === "ramps") {
    return isModuleInReleaseChannel(releaseChannel, module, rampProviderMaturity);
  }
  if (module === "markets") {
    return (["earn", "dvp"] as const).some((marketsModule) =>
      isMaturityInReleaseChannel(SDP_MODULE_MATURITY[marketsModule][environment], releaseChannel)
    );
  }
  return isMaturityInReleaseChannel(SDP_MODULE_MATURITY[module][environment], releaseChannel);
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
