import type * as SdpTypes from "@sdp/types";
import type {
  EarnProviderId,
  RampProviderId,
  SdpModule,
  SdpRampProviderStages,
  SdpReleaseChannel,
} from "@sdp/types";

type SdpTypesModule = typeof SdpTypes;

/** `@sdp/types` with its ramp stage manifest widened to any stage per provider. */
export type ProviderStagesModule = Omit<SdpTypesModule, "SDP_RAMP_PROVIDER_STAGES"> & {
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
 * Per-file toggle read by {@link mockProviderStages}. A test file sets
 * `rampStageOverride` to give one ramp provider another stage, or
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
 * Build the `@sdp/types` mock whose `SDP_RAMP_PROVIDER_STAGES` reads the
 * overridden provider's stage from `providerStages.rampStageOverride`, and whose
 * module predicates read the overridden module's stage from
 * `providerStages.moduleStageOverride`, and whose `isEarnProviderSurfaced` also
 * surfaces `providerStages.surfacedEarnProvider`; everything else is the real module.
 * Load it with `await import()` inside the test file's `vi.mock` factory, so the
 * factory and the test share this module's toggle.
 * @param original - The real module, from the factory's `importOriginal`.
 * @returns The module with its ramp stage manifest, module predicates and Earn surfacing overridden.
 */
export function mockProviderStages(original: SdpTypesModule): ProviderStagesModule {
  const rampProviderStages: SdpRampProviderStages = { ...original.SDP_RAMP_PROVIDER_STAGES };
  for (const provider of original.RAMP_PROVIDERS) {
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
  const isModuleInReleaseChannel: SdpTypesModule["isModuleInReleaseChannel"] = (
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
    isEarnProviderSurfaced: (provider) =>
      provider === providerStages.surfacedEarnProvider || original.isEarnProviderSurfaced(provider),
  };
}
