import assert from "node:assert/strict";
import {
  isCustodyProviderInReleaseChannel,
  SDP_RELEASE_CHANNEL_NAMES,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";

// Channels come from the shared maturity tables, so promoting a provider moves these with it. The
// least mature channel offers every provider.
export const EVERY_PROVIDER_CHANNEL: SdpReleaseChannel = SDP_RELEASE_CHANNEL_NAMES[0];

export function channelOfferingOne() {
  for (const [offered, refused] of [
    ["fireblocks", "privy"],
    ["privy", "fireblocks"],
  ] as const) {
    const releaseChannel = SDP_RELEASE_CHANNEL_NAMES.find(
      (name) =>
        isCustodyProviderInReleaseChannel(name, offered, "managed") &&
        !isCustodyProviderInReleaseChannel(name, refused, "managed")
    );
    if (releaseChannel !== undefined) return { releaseChannel, offered, refused };
  }
  assert.fail("no release channel offers one provider without the other");
}
