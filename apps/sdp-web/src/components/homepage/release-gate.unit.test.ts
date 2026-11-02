import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GatedSurface, heroLedeKey, isComingSoon, startSubKey } from "./release-gate";

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

describe("the homepage's words per channel", () => {
  // Stable's hero and close sold issuing and earning as live; each now says coming soon.
  it.each([
    { channel: "stable", lede: "Homepage.hero.ledeSoon", sub: "Homepage.start.subIssuanceSoon" },
    {
      channel: "beta",
      lede: "Homepage.hero.ledeIssuanceSoon",
      sub: "Homepage.start.subIssuanceSoon",
    },
    { channel: "experimental", lede: "Homepage.hero.lede", sub: "Homepage.start.sub" },
  ] as const)("says coming soon for what $channel holds back", ({ channel, lede, sub }) => {
    vi.stubEnv("SDP_RELEASE_CHANNEL", channel);
    expect(heroLedeKey()).toBe(lede);
    expect(startSubKey()).toBe(sub);
  });
});
