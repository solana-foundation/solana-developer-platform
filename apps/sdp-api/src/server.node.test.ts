import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { assertRequiredEnv } from "./server";

function makeEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  return {
    ENVIRONMENT: "production",
    API_VERSION: "v1",
    DATABASE_URL: "postgres://unit",
    REDIS_URL: "redis://unit",
    SIGNING_PROVIDER: "coinbase_cdp",
    CUSTODY_KMS_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
    SDP_RELEASE_CHANNEL: "stable",
    ...overrides,
  } as Env;
}

describe("server boot checks", () => {
  it("runs the release channel boot check", () => {
    expect(() => assertRequiredEnv(makeEnv())).not.toThrow();
    expect(() => assertRequiredEnv(makeEnv({ SDP_RELEASE_CHANNEL: "" }))).toThrow(
      /SDP_RELEASE_CHANNEL is required/
    );
  });

  it("refuses the e2e dashboard rate limit profile on Cloud Run", () => {
    expect(() =>
      assertRequiredEnv(makeEnv({ SDP_DASHBOARD_RATE_LIMIT_PROFILE: "e2e" }))
    ).not.toThrow();
    expect(() =>
      assertRequiredEnv(makeEnv({ SDP_DASHBOARD_RATE_LIMIT_PROFILE: "e2e", K_SERVICE: "sdp-api" }))
    ).toThrow(/refused on Cloud Run/);
  });
});
