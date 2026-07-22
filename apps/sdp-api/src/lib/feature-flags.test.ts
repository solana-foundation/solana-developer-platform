import { describe, expect, it } from "vitest";
import { isAssetProfilesEnabled } from "./feature-flags";

describe("isAssetProfilesEnabled", () => {
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
        ASSET_PROFILES_ENABLED: flag,
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
        ASSET_PROFILES_ENABLED: flag,
      })
    ).toBe(false);
  });

  it.each(["1", "true", " TRUE ", "yes", "on"])("honors the production opt-in value %s", (flag) => {
    expect(
      isAssetProfilesEnabled({
        ENVIRONMENT: "production",
        ASSET_PROFILES_ENABLED: flag,
      })
    ).toBe(true);
  });
});
