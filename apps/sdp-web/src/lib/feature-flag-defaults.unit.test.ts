import { describe, expect, it } from "vitest";
import {
  getAssetProfilesDefault,
  getDeveloperControlsDefault,
  getHomepageOpenSignupDefault,
} from "./feature-flag-defaults";

describe("getHomepageOpenSignupDefault", () => {
  it("defaults Vercel production to the waitlist", () => {
    expect(getHomepageOpenSignupDefault({ vercelEnvironment: "production" })).toBe(false);
  });

  it.each([
    "preview",
    "development",
    undefined,
  ])("defaults %s deployments to open signup", (vercelEnvironment) => {
    expect(getHomepageOpenSignupDefault({ vercelEnvironment })).toBe(true);
  });
});

describe("getAssetProfilesDefault", () => {
  it.each([
    "preview",
    "development",
    " PREVIEW ",
  ])("enables the %s Vercel environment", (vercelEnvironment) => {
    expect(
      getAssetProfilesDefault({
        nodeEnvironment: "production",
        vercelEnvironment,
      })
    ).toBe(true);
  });

  it.each([
    "production",
    "staging",
    "unexpected",
  ])("fails closed for the %s Vercel environment", (vercelEnvironment) => {
    expect(
      getAssetProfilesDefault({
        nodeEnvironment: "development",
        vercelEnvironment,
      })
    ).toBe(false);
  });

  it("enables self-hosted development", () => {
    expect(
      getAssetProfilesDefault({
        nodeEnvironment: "production",
        sdpEnvironment: "development",
      })
    ).toBe(true);
  });

  it("keeps self-hosted production disabled", () => {
    expect(
      getAssetProfilesDefault({
        nodeEnvironment: "production",
        sdpEnvironment: "production",
      })
    ).toBe(false);
  });

  it("honors the server-only self-hosted production opt-in", () => {
    expect(
      getAssetProfilesDefault({
        assetProfilesEnabled: " TRUE ",
        nodeEnvironment: "production",
        sdpEnvironment: "production",
      })
    ).toBe(true);
  });

  it.each(["development", "test"])("enables local %s", (nodeEnvironment) => {
    expect(getAssetProfilesDefault({ nodeEnvironment })).toBe(true);
  });
});

describe("getDeveloperControlsDefault", () => {
  it("is on where the team works and off anywhere production-like", () => {
    // Vercel wins when set: preview and dev builds are ours, production is not.
    expect(getDeveloperControlsDefault({ vercelEnvironment: "preview" })).toBe(true);
    expect(getDeveloperControlsDefault({ vercelEnvironment: "development" })).toBe(true);
    expect(getDeveloperControlsDefault({ vercelEnvironment: "production" })).toBe(false);
    // A self-hosted deployment declares its own environment.
    expect(getDeveloperControlsDefault({ sdpEnvironment: "development" })).toBe(true);
    expect(getDeveloperControlsDefault({ sdpEnvironment: "production" })).toBe(false);
    expect(getDeveloperControlsDefault({ sdpEnvironment: "staging" })).toBe(false);
    // Falling all the way through, only local dev and the test runner qualify.
    expect(getDeveloperControlsDefault({ nodeEnvironment: "development" })).toBe(true);
    expect(getDeveloperControlsDefault({ nodeEnvironment: "test" })).toBe(true);
    expect(getDeveloperControlsDefault({ nodeEnvironment: "production" })).toBe(false);
    expect(getDeveloperControlsDefault({})).toBe(false);
  });

  it("does not take the asset-profiles override as permission", () => {
    // ASSET_PROFILES_ENABLED opens a product surface, not our tuning controls.
    expect(
      getDeveloperControlsDefault({ assetProfilesEnabled: "true", sdpEnvironment: "production" })
    ).toBe(false);
  });
});
