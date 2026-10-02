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
  it("boots a managed production deployment that names its release channel", () => {
    expect(() => assertRequiredEnv(makeEnv())).not.toThrow();
  });

  it("refuses managed production without a release channel", () => {
    expect(() => assertRequiredEnv(makeEnv({ SDP_RELEASE_CHANNEL: "" }))).toThrow(
      /SDP_RELEASE_CHANNEL is required/
    );
  });

  it("refuses an unknown release channel", () => {
    expect(() => assertRequiredEnv(makeEnv({ SDP_RELEASE_CHANNEL: "mainnet" }))).toThrow(
      /SDP_RELEASE_CHANNEL must be one of/
    );
  });
});
