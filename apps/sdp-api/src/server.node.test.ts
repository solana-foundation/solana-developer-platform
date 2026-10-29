import { describe, expect, it } from "vitest";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
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
    API_KEY_PEPPER: "unit-pepper",
    ...overrides,
  } as Env;
}

describe("server boot checks", () => {
  installClusterRpcStub();

  it("runs the release channel boot check", () => {
    expect(() => assertRequiredEnv(makeEnv())).not.toThrow();
    expect(() => assertRequiredEnv(makeEnv({ SDP_RELEASE_CHANNEL: "" }))).toThrow(
      /SDP_RELEASE_CHANNEL is required/
    );
  });

  it("refuses to boot without an API key pepper", () => {
    for (const pepper of ["", "  "]) {
      expect(() => assertRequiredEnv(makeEnv({ API_KEY_PEPPER: pepper }))).toThrow(
        /API_KEY_PEPPER is required/
      );
    }
    const { API_KEY_PEPPER: _omitted, ...withoutPepper } = makeEnv();
    expect(() => assertRequiredEnv(withoutPepper)).toThrow(/API_KEY_PEPPER is required/);
  });

  it("refuses a DATABASE_PREPARED_STATEMENTS value other than on or off", () => {
    expect(() => assertRequiredEnv(makeEnv({ DATABASE_PREPARED_STATEMENTS: "off" }))).not.toThrow();
    expect(() => assertRequiredEnv(makeEnv({ DATABASE_PREPARED_STATEMENTS: "of" }))).toThrow(
      /DATABASE_PREPARED_STATEMENTS/
    );
  });
});
