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

  it("refuses to boot production Clerk auth without the dashboard URL", () => {
    const clerkIssuer = "https://clerk.platform.example";
    expect(() => assertRequiredEnv(makeEnv({ CLERK_ISSUER: clerkIssuer }))).toThrow(/FRONTEND_URL/);
    expect(() =>
      assertRequiredEnv(
        makeEnv({ CLERK_ISSUER: clerkIssuer, FRONTEND_URL: "https://platform.example" })
      )
    ).not.toThrow();
  });

  it("refuses a DATABASE_PREPARED_STATEMENTS value other than on or off", () => {
    expect(() => assertRequiredEnv(makeEnv({ DATABASE_PREPARED_STATEMENTS: "off" }))).not.toThrow();
    expect(() => assertRequiredEnv(makeEnv({ DATABASE_PREPARED_STATEMENTS: "of" }))).toThrow(
      /DATABASE_PREPARED_STATEMENTS/
    );
  });

  describe("Kora Cloud Run audience", () => {
    const mainnetKora = {
      KORA_MAINNET_URL: "https://kora-mainnet.mock.invalid",
      KORA_MAINNET_RPC_URL: "https://kora-mainnet-upstream.mock.invalid",
    };

    it("refuses managed stage and prod with a Kora URL but no audience", () => {
      expect(() => assertRequiredEnv(makeEnv(mainnetKora))).toThrow(
        /set KORA_MAINNET_CLOUD_RUN_AUDIENCE/
      );
      expect(() =>
        assertRequiredEnv(
          makeEnv({
            ...mainnetKora,
            KORA_MAINNET_CLOUD_RUN_AUDIENCE: "https://kora-mainnet.mock.invalid",
          })
        )
      ).not.toThrow();
    });

    it("boots dev and self-hosted without an audience", () => {
      expect(() =>
        assertRequiredEnv(makeEnv({ ...mainnetKora, ENVIRONMENT: "development" }))
      ).not.toThrow();
      expect(() =>
        assertRequiredEnv(
          makeEnv({ ...mainnetKora, SDP_DEPLOYMENT_MODE: "self_hosted", SIGNING_PROVIDER: "local" })
        )
      ).not.toThrow();
    });
  });
});
