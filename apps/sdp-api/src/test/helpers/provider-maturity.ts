import type { SdpEnvironment } from "@sdp/types/api-keys";
import type * as ProviderAccess from "@sdp/types/provider-access";
import type { EarnProviderId, RampProviderId } from "@sdp/types/provider-access";
import type * as ReleaseChannels from "@sdp/types/release-channels";
import type {
  SdpModule,
  SdpRampProviderMaturity,
  SdpReleaseChannel,
} from "@sdp/types/release-channels";

type ReleaseChannelsModule = typeof ReleaseChannels;
type ProviderAccessModule = typeof ProviderAccess;

/** `@sdp/types/release-channels` with its ramp stage manifest widened to any stage per provider. */
export type ReleaseChannelMaturityModule = Omit<
  ReleaseChannelsModule,
  "SDP_RAMP_PROVIDER_MATURITY"
> & {
  SDP_RAMP_PROVIDER_MATURITY: SdpRampProviderMaturity;
};

/** One ramp provider whose stage a test replaces. */
interface RampMaturityOverride {
  provider: RampProviderId;
  stage: SdpReleaseChannel;
}

/** One module whose stage a test replaces. */
interface ModuleMaturityOverride {
  module: SdpModule;
  stage: SdpReleaseChannel;
}

/** One module whose stage for one environment's projects a test replaces. */
interface ModuleEnvironmentMaturityOverride {
  module: SdpModule;
  environment: SdpEnvironment;
  stage: SdpReleaseChannel;
}

export interface ProviderMaturityToggle {
  rampMaturityOverride: RampMaturityOverride | null;
  moduleMaturityOverride: ModuleMaturityOverride | null;
  moduleEnvironmentMaturityOverride: ModuleEnvironmentMaturityOverride | null;
  surfacedEarnProvider: EarnProviderId | null;
}

/**
 * Per-file toggle read by {@link mockReleaseChannelMaturity} and
 * {@link mockEarnProviderSurfacing}. A test file sets `rampMaturityOverride` to
 * give one ramp provider another stage, or
 * `moduleMaturityOverride` to give one module another stage, or
 * `moduleEnvironmentMaturityOverride` to give one module another stage for one
 * environment's projects, or
 * `surfacedEarnProvider` to surface one Earn provider the real surfacing table
 * hides, and resets whichever it sets to `null` in its `beforeEach`.
 */
export const providerMaturity: ProviderMaturityToggle = {
  rampMaturityOverride: null,
  moduleMaturityOverride: null,
  moduleEnvironmentMaturityOverride: null,
  surfacedEarnProvider: null,
};

/** Whether a release channel runs something staged at `stage`. */
function isStageInReleaseChannel(
  original: ReleaseChannelsModule,
  stage: SdpReleaseChannel,
  releaseChannel: SdpReleaseChannel
): boolean {
  return (
    original.SDP_RELEASE_CHANNEL_NAMES.indexOf(stage) >=
    original.SDP_RELEASE_CHANNEL_NAMES.indexOf(releaseChannel)
  );
}

/**
 * Build the `@sdp/types/release-channels` mock whose `SDP_RAMP_PROVIDER_MATURITY`
 * reads the overridden provider's stage from `providerMaturity.rampMaturityOverride`,
 * whose `isModuleInReleaseChannel` reads the overridden module's stage from
 * `providerMaturity.moduleMaturityOverride`, and whose
 * `isModuleInReleaseChannelForEnvironment` reads the overridden (module, environment)
 * stage from `providerMaturity.moduleEnvironmentMaturityOverride`, then the module's
 * stage from `providerMaturity.moduleMaturityOverride` for every environment; everything
 * else is the real module.
 * Load it with `await import()` inside the test file's `vi.mock` factory, so the
 * factory and the test share this module's toggle.
 * @param original - The real module, from the factory's `importOriginal`.
 * @param rampProviders - `RAMP_PROVIDERS` from `@sdp/types/provider-access`.
 * @returns The module with its ramp stage manifest and module predicates overridden.
 */
export function mockReleaseChannelMaturity(
  original: ReleaseChannelsModule,
  rampProviders: readonly RampProviderId[]
): ReleaseChannelMaturityModule {
  const rampProviderMaturity: SdpRampProviderMaturity = { ...original.SDP_RAMP_PROVIDER_MATURITY };
  for (const provider of rampProviders) {
    Object.defineProperty(rampProviderMaturity, provider, {
      enumerable: true,
      get: () => {
        const override = providerMaturity.rampMaturityOverride;
        return override !== null && override.provider === provider
          ? override.stage
          : original.SDP_RAMP_PROVIDER_MATURITY[provider];
      },
    });
  }
  const isModuleInReleaseChannel: ReleaseChannelsModule["isModuleInReleaseChannel"] = (
    releaseChannel,
    module,
    stages
  ) => {
    const override = providerMaturity.moduleMaturityOverride;
    if (override !== null && override.module === module) {
      return isStageInReleaseChannel(original, override.stage, releaseChannel);
    }
    return original.isModuleInReleaseChannel(releaseChannel, module, stages);
  };
  const isModuleInReleaseChannelForEnvironment: ReleaseChannelsModule["isModuleInReleaseChannelForEnvironment"] =
    (releaseChannel, module, environment, stages) => {
      const override = providerMaturity.moduleEnvironmentMaturityOverride;
      if (override !== null && override.module === module && override.environment === environment) {
        return isStageInReleaseChannel(original, override.stage, releaseChannel);
      }
      const moduleOverride = providerMaturity.moduleMaturityOverride;
      if (moduleOverride !== null && moduleOverride.module === module) {
        return isStageInReleaseChannel(original, moduleOverride.stage, releaseChannel);
      }
      return original.isModuleInReleaseChannelForEnvironment(
        releaseChannel,
        module,
        environment,
        stages
      );
    };
  return {
    ...original,
    SDP_RAMP_PROVIDER_MATURITY: rampProviderMaturity,
    isModuleInReleaseChannel,
    isModuleInReleaseChannelForEnvironment,
  };
}

/**
 * Build the `@sdp/types/provider-access` mock whose `isEarnProviderSurfaced` also
 * surfaces `providerMaturity.surfacedEarnProvider`; everything else is the real module.
 * Load it with `await import()` inside the test file's `vi.mock` factory.
 * @param original - The real module, from the factory's `importOriginal`.
 * @returns The module with its Earn surfacing overridden.
 */
export function mockEarnProviderSurfacing(original: ProviderAccessModule): ProviderAccessModule {
  return {
    ...original,
    isEarnProviderSurfaced: (provider) =>
      provider === providerMaturity.surfacedEarnProvider ||
      original.isEarnProviderSurfaced(provider),
  };
}
