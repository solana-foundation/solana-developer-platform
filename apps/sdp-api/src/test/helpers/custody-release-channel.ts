import type { CustodyMode } from "@sdp/types";
import type * as ReleaseChannels from "@sdp/types/release-channels";

type ReleaseChannelsModule = typeof ReleaseChannels;

export interface CustodyReleaseChannelToggle {
  outOfChannelMode: CustodyMode | null;
}

/**
 * Per-file toggle read by {@link mockCustodyReleaseChannels}. A test file sets
 * `outOfChannelMode` to take every provider in that custody mode out of the
 * release channel, and resets it to `null` in its `beforeEach`.
 */
export const custodyReleaseChannel: CustodyReleaseChannelToggle = { outOfChannelMode: null };

/**
 * Build the `@sdp/types/release-channels` mock whose custody predicate refuses
 * every pair in `custodyReleaseChannel.outOfChannelMode` and otherwise defers to
 * the real stages. Load it with `await import()` inside the test file's
 * `vi.mock` factory, so the factory and the test share this module's toggle.
 * @param original - The real module, from the factory's `importOriginal`.
 * @returns The module with its custody predicate overridden.
 */
export function mockCustodyReleaseChannels(original: ReleaseChannelsModule): ReleaseChannelsModule {
  return {
    ...original,
    isCustodyProviderInReleaseChannel: (releaseChannel, provider, mode) =>
      mode !== custodyReleaseChannel.outOfChannelMode &&
      original.isCustodyProviderInReleaseChannel(releaseChannel, provider, mode),
  };
}
