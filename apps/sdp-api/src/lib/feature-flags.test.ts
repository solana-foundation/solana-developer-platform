import { describe, expect, it } from "vitest";
import {
  isAssetProfilesEnabled,
  isEarnEnabled,
  isMarketsEnabled,
  isPrivateChannelsEnabled,
  isPrivyByokEnabled,
} from "./feature-flags";

describe("isAssetProfilesEnabled", () => {
  it.each([
    undefined,
    "managed",
  ] as const)("keeps the managed API capability available when deployment mode is %s", (deploymentMode) => {
    expect(
      isAssetProfilesEnabled({
        ENVIRONMENT: "production",
        SDP_DEPLOYMENT_MODE: deploymentMode,
      })
    ).toBe(true);
  });

  it.each([
    undefined,
    "",
    "false",
    "0",
    "off",
  ])("enables Asset Profiles in development when the flag is %s", (flag) => {
    expect(
      isAssetProfilesEnabled({
        ENVIRONMENT: "development",
        SDP_FLAG_ASSET_PROFILES: flag,
        SDP_DEPLOYMENT_MODE: "self_hosted",
      })
    ).toBe(true);
  });

  it.each([
    undefined,
    "",
    "false",
    "0",
    "off",
  ])("keeps Asset Profiles disabled in production when the flag is %s", (flag) => {
    expect(
      isAssetProfilesEnabled({
        ENVIRONMENT: "production",
        SDP_FLAG_ASSET_PROFILES: flag,
        SDP_DEPLOYMENT_MODE: "self_hosted",
      })
    ).toBe(false);
  });

  it.each(["1", "true", " TRUE ", "yes", "on"])("honors the production opt-in value %s", (flag) => {
    expect(
      isAssetProfilesEnabled({
        ENVIRONMENT: "production",
        SDP_FLAG_ASSET_PROFILES: flag,
        SDP_DEPLOYMENT_MODE: "self_hosted",
      })
    ).toBe(true);
  });
});

describe("isPrivateChannelsEnabled", () => {
  it.each([undefined, "", "false", "0", "off"])("is disabled when the flag is %s", (flag) => {
    expect(isPrivateChannelsEnabled({ PRIVATE_CHANNELS_ENABLED: flag })).toBe(false);
  });

  it.each(["1", "true", " TRUE ", "yes", "on"])("honors the opt-in value %s", (flag) => {
    expect(isPrivateChannelsEnabled({ PRIVATE_CHANNELS_ENABLED: flag })).toBe(true);
  });
});

describe("isPrivyByokEnabled", () => {
  it.each([undefined, "", "false", "0", "off"])("is disabled when the flag is %s", (flag) => {
    expect(
      isPrivyByokEnabled({
        PRIVY_BYOK_ENABLED: flag,
      })
    ).toBe(false);
  });

  it.each(["1", "true", " TRUE ", "yes", "on"])("honors the opt-in value %s", (flag) => {
    expect(
      isPrivyByokEnabled({
        PRIVY_BYOK_ENABLED: flag,
      })
    ).toBe(true);
  });
});

describe("isMarketsEnabled", () => {
  it.each([undefined, "", "false", "0", "off"])("is disabled when the flag is %s", (flag) => {
    expect(isMarketsEnabled({ MARKETS_ENABLED: flag })).toBe(false);
  });

  it.each(["1", "true", " TRUE ", "yes", "on"])("honors the opt-in value %s", (flag) => {
    expect(isMarketsEnabled({ MARKETS_ENABLED: flag })).toBe(true);
  });
});

describe("isEarnEnabled", () => {
  it("is disabled when both flags are unset", () => {
    expect(isEarnEnabled({ MARKETS_ENABLED: undefined, EARN_ENABLED: undefined })).toBe(false);
  });

  it("is disabled when Markets is on but Earn is unset", () => {
    expect(isEarnEnabled({ MARKETS_ENABLED: "true", EARN_ENABLED: undefined })).toBe(false);
  });

  // The parent gate has to win: Earn is a Markets sub-module, so disabling
  // Markets must dark-launch Earn even with its own flag still turned on.
  it.each([
    undefined,
    "",
    "false",
    "0",
    "off",
  ])("stays disabled when Earn is on but Markets is %s", (markets) => {
    expect(isEarnEnabled({ MARKETS_ENABLED: markets, EARN_ENABLED: "true" })).toBe(false);
  });

  it.each([
    "1",
    "true",
    " TRUE ",
    "yes",
    "on",
  ])("honors the opt-in value %s on both flags", (flag) => {
    expect(isEarnEnabled({ MARKETS_ENABLED: flag, EARN_ENABLED: flag })).toBe(true);
  });
});
