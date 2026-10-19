import type * as ProviderAccess from "@sdp/types/provider-access";
import type { EarnProviderId, RampProviderId } from "@sdp/types/provider-access";
import type * as ReleaseChannels from "@sdp/types/release-channels";
import type {
  SdpModule,
  SdpRampProviderStages,
  SdpReleaseChannel,
} from "@sdp/types/release-channels";

type ReleaseChannelsModule = typeof ReleaseChannels;
type ProviderAccessModule = typeof ProviderAccess;

/** `@sdp/types/release-channels` with its ramp stage manifest widened to any stage per provider. */
export type ReleaseChannelStagesModule = Omit<ReleaseChannelsModule, "SDP_RAMP_PROVIDER_STAGES"> & {
  SDP_RAMP_PROVIDER_STAGES: SdpRampProviderStages;
};

/** One ramp provider whose stage a test replaces. */
export interface RampStageOverride {
  provider: RampProviderId;
  stage: SdpReleaseChannel;
}

/** One module whose stage a test replaces. */
export interface ModuleStageOverride {
  module: SdpModule;
  stage: SdpReleaseChannel;
}

export interface ProviderStageToggle {
  rampStageOverride: RampStageOverride | null;
  moduleStageOverride: ModuleStageOverride | null;
  surfacedEarnProvider: EarnProviderId | null;
}

/**
 * Per-file toggle read by {@link mockReleaseChannelStages} and
 * {@link mockEarnProviderSurfacing}. A test file sets `rampStageOverride` to
 * give one ramp provider another stage, or
 * `moduleStageOverride` to give one module another stage, or
 * `surfacedEarnProvider` to surface one Earn provider the real surfacing table
 * hides, and resets whichever it sets to `null` in its `beforeEach`.
 */
export const providerStages: ProviderStageToggle = {
  rampStageOverride: null,
  moduleStageOverride: null,
  surfacedEarnProvider: null,
};

/**
 * Build the `@sdp/types/release-channels` mock whose `SDP_RAMP_PROVIDER_STAGES`
 * reads the overridden provider's stage from `providerStages.rampStageOverride`,
 * and whose `isModuleInReleaseChannel` reads the overridden module's stage from
 * `providerStages.moduleStageOverride`; everything else is the real module.
 * Load it with `await import()` inside the test file's `vi.mock` factory, so the
 * factory and the test share this module's toggle.
 * @param original - The real module, from the factory's `importOriginal`.
 * @param rampProviders - `RAMP_PROVIDERS` from `@sdp/types/provider-access`.
 * @returns The module with its ramp stage manifest and module predicate overridden.
 */
export function mockReleaseChannelStages(
  original: ReleaseChannelsModule,
  rampProviders: readonly RampProviderId[]
): ReleaseChannelStagesModule {
  const rampProviderStages: SdpRampProviderStages = { ...original.SDP_RAMP_PROVIDER_STAGES };
  for (const provider of rampProviders) {
    Object.defineProperty(rampProviderStages, provider, {
      enumerable: true,
      get: () => {
        const override = providerStages.rampStageOverride;
        return override !== null && override.provider === provider
          ? override.stage
          : original.SDP_RAMP_PROVIDER_STAGES[provider];
      },
    });
  }
  const isModuleInReleaseChannel: ReleaseChannelsModule["isModuleInReleaseChannel"] = (
    releaseChannel,
    module,
    stages
  ) => {
    const override = providerStages.moduleStageOverride;
    if (override !== null && override.module === module) {
      return (
        original.SDP_RELEASE_CHANNEL_NAMES.indexOf(override.stage) >=
        original.SDP_RELEASE_CHANNEL_NAMES.indexOf(releaseChannel)
      );
    }
    return original.isModuleInReleaseChannel(releaseChannel, module, stages);
  };
  return {
    ...original,
    SDP_RAMP_PROVIDER_STAGES: rampProviderStages,
    isModuleInReleaseChannel,
  };
}

/**
 * Build the `@sdp/types/provider-access` mock whose `isEarnProviderSurfaced` also
 * surfaces `providerStages.surfacedEarnProvider`; everything else is the real module.
 * Load it with `await import()` inside the test file's `vi.mock` factory.
 * @param original - The real module, from the factory's `importOriginal`.
 * @returns The module with its Earn surfacing overridden.
 */
export function mockEarnProviderSurfacing(original: ProviderAccessModule): ProviderAccessModule {
  return {
    ...original,
    isEarnProviderSurfaced: (provider) =>
      provider === providerStages.surfacedEarnProvider || original.isEarnProviderSurfaced(provider),
  };
}
