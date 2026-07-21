import { afterEach, describe, expect, it, vi } from "vitest";
import { isAssetProfilesUiEnabled } from "./asset-profiles-feature";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubEnvironment({
  flag = "",
  node = "production",
  vercel = "",
}: {
  flag?: string;
  node?: string;
  vercel?: string;
}) {
  vi.stubEnv("NEXT_PUBLIC_ASSET_PROFILES_ENABLED", flag);
  vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", vercel);
  vi.stubEnv("NODE_ENV", node);
}

describe("isAssetProfilesUiEnabled", () => {
  it.each(["development", "test"])("enables local %s builds", (node) => {
    stubEnvironment({ node });
    expect(isAssetProfilesUiEnabled()).toBe(true);
  });

  it.each([
    "preview",
    "development",
    " PREVIEW ",
  ])("enables Vercel's %s environment even in a production-mode build", (vercel) => {
    stubEnvironment({ node: "production", vercel });
    expect(isAssetProfilesUiEnabled()).toBe(true);
  });

  it("keeps Vercel production disabled without the explicit flag", () => {
    stubEnvironment({ vercel: "production" });
    expect(isAssetProfilesUiEnabled()).toBe(false);
  });

  it("honors the explicit production opt-in", () => {
    stubEnvironment({ flag: "true", vercel: "production" });
    expect(isAssetProfilesUiEnabled()).toBe(true);
  });

  it.each([
    "",
    "staging",
    "unexpected",
  ])("fails closed for the unrecognized deployment marker %s in production-mode builds", (vercel) => {
    stubEnvironment({ vercel });
    expect(isAssetProfilesUiEnabled()).toBe(false);
  });
});
