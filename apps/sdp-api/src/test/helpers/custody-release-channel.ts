import type { CustodyMode, CustodyProvider, SdpReleaseChannel } from "@sdp/types";
import type * as ReleaseChannels from "@sdp/types/release-channels";

type ReleaseChannelsModule = typeof ReleaseChannels;

/** One (custody provider, mode) pair whose stage a test replaces. */
export interface CustodyStageOverride {
  provider: CustodyProvider;
  mode: CustodyMode;
  stage: SdpReleaseChannel;
}

export interface CustodyReleaseChannelToggle {
  outOfChannelMode: CustodyMode | null;
  stageOverride: CustodyStageOverride | null;
}

/**
 * Per-file toggle read by {@link mockCustodyReleaseChannels}. A test file sets
 * `outOfChannelMode` to take every provider in that custody mode out of the
 * release channel, or `stageOverride` to give one pair another stage, and resets
 * whichever it sets to `null` in its `beforeEach`.
 */
export const custodyReleaseChannel: CustodyReleaseChannelToggle = {
  outOfChannelMode: null,
  stageOverride: null,
};

/**
 * Build the `@sdp/types/release-channels` mock whose custody predicate refuses
 * every pair in `custodyReleaseChannel.outOfChannelMode`, reads the overridden
 * pair's stage from `custodyReleaseChannel.stageOverride`, and otherwise defers
 * to the real stages. The environment stage predicate keeps the real rule but
 * asks the mocked custody predicate, since its in-module call is out of a module
 * mock's reach. Load it with `await import()` inside the test file's `vi.mock`
 * factory, so the factory and the test share this module's toggle.
 * @param original - The real module, from the factory's `importOriginal`.
 * @returns The module with its custody predicates overridden.
 */
export function mockCustodyReleaseChannels(original: ReleaseChannelsModule): ReleaseChannelsModule {
  const isCustodyProviderInReleaseChannel: ReleaseChannelsModule["isCustodyProviderInReleaseChannel"] =
    (releaseChannel, provider, mode) => {
      if (mode === custodyReleaseChannel.outOfChannelMode) {
        return false;
      }
      const override = custodyReleaseChannel.stageOverride;
      if (override !== null && override.provider === provider && override.mode === mode) {
        return (
          original.SDP_RELEASE_CHANNEL_NAMES.indexOf(override.stage) >=
          original.SDP_RELEASE_CHANNEL_NAMES.indexOf(releaseChannel)
        );
      }
      return original.isCustodyProviderInReleaseChannel(releaseChannel, provider, mode);
    };
  return {
    ...original,
    isCustodyProviderInReleaseChannel,
    isCustodyProviderStageAllowedInEnvironment: (environment, provider, mode) =>
      environment === "production"
        ? isCustodyProviderInReleaseChannel("stable", provider, mode)
        : original.isCustodyProviderStageAllowedInEnvironment(environment, provider, mode),
  };
}
