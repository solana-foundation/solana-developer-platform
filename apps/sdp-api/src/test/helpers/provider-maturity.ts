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

export interface ProviderMaturityToggle {
  rampMaturityOverride: RampMaturityOverride | null;
  moduleMaturityOverride: ModuleMaturityOverride | null;
  surfacedEarnProvider: EarnProviderId | null;
}

/**
 * Per-file toggle read by {@link mockReleaseChannelMaturity} and
 * {@link mockEarnProviderSurfacing}. A test file sets `rampMaturityOverride` to
 * give one ramp provider another stage, or
 * `moduleMaturityOverride` to give one module another stage, or
 * `surfacedEarnProvider` to surface one Earn provider the real surfacing table
 * hides, and resets whichever it sets to `null` in its `beforeEach`.
 */
export const providerMaturity: ProviderMaturityToggle = {
  rampMaturityOverride: null,
  moduleMaturityOverride: null,
  surfacedEarnProvider: null,
};

/**
 * Build the `@sdp/types/release-channels` mock whose `SDP_RAMP_PROVIDER_MATURITY`
 * reads the overridden provider's stage from `providerMaturity.rampMaturityOverride`,
 * and whose `isModuleInReleaseChannel` reads the overridden module's stage from
 * `providerMaturity.moduleMaturityOverride`; everything else is the real module.
 * Load it with `await import()` inside the test file's `vi.mock` factory, so the
 * factory and the test share this module's toggle.
 * @param original - The real module, from the factory's `importOriginal`.
 * @param rampProviders - `RAMP_PROVIDERS` from `@sdp/types/provider-access`.
 * @returns The module with its ramp stage manifest and module predicate overridden.
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
      return (
        original.SDP_RELEASE_CHANNEL_NAMES.indexOf(override.stage) >=
        original.SDP_RELEASE_CHANNEL_NAMES.indexOf(releaseChannel)
      );
    }
    return original.isModuleInReleaseChannel(releaseChannel, module, stages);
  };
  return {
    ...original,
    SDP_RAMP_PROVIDER_MATURITY: rampProviderMaturity,
    isModuleInReleaseChannel,
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
