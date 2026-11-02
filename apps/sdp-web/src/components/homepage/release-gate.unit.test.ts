import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GatedSurface, isComingSoon } from "./release-gate";

const SURFACES: readonly GatedSurface[] = ["issuance", "markets", "privacy", "compliance", "ramps"];

const cases: { channel: SdpReleaseChannel; comingSoon: Record<GatedSurface, boolean> }[] = [
  {
    channel: "stable",
    comingSoon: { issuance: true, markets: true, privacy: true, compliance: true, ramps: true },
  },
  {
    channel: "beta",
    comingSoon: { issuance: true, markets: false, privacy: true, compliance: true, ramps: true },
  },
  {
    channel: "experimental",
    comingSoon: {
      issuance: false,
      markets: false,
      privacy: false,
      compliance: false,
      ramps: false,
    },
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isComingSoon", () => {
  it.each(cases)(
    "holds back the surfaces outside the $channel channel",
    ({ channel, comingSoon }) => {
      vi.stubEnv("SDP_RELEASE_CHANNEL", channel);
      expect(
        Object.fromEntries(SURFACES.map((surface) => [surface, isComingSoon(surface)]))
      ).toEqual(comingSoon);
    }
  );
});
