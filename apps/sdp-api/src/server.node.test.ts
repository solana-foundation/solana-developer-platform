import { describe, expect, it, vi } from "vitest";
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

  it("refuses to boot production Clerk auth without an http(s) dashboard URL", () => {
    const clerkIssuer = "https://clerk.platform.example";
    expect(() => assertRequiredEnv(makeEnv({ CLERK_ISSUER: clerkIssuer }))).toThrow(/FRONTEND_URL/);
    expect(() =>
      assertRequiredEnv(makeEnv({ CLERK_ISSUER: clerkIssuer, FRONTEND_URL: "file:///dashboard" }))
    ).toThrow(/FRONTEND_URL/);
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

  describe("managed RPC pools", () => {
    it("refuses stage and prod without a mainnet pool", () => {
      vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", "");

      expect(() => assertRequiredEnv(makeEnv())).toThrow(/mainnet-beta/);
      expect(() => assertRequiredEnv(makeEnv({ SDP_ALLOW_PRODUCTION_PROJECTS: "true" }))).toThrow(
        /mainnet-beta/
      );
    });

    it("boots a devnet-only deployment with no mainnet pool", () => {
      vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", "");

      expect(() =>
        assertRequiredEnv(makeEnv({ SDP_ALLOW_PRODUCTION_PROJECTS: "false" }))
      ).not.toThrow();
    });

    it("still refuses a devnet-only deployment without a devnet pool", () => {
      vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", "");

      expect(() => assertRequiredEnv(makeEnv({ SDP_ALLOW_PRODUCTION_PROJECTS: "false" }))).toThrow(
        /devnet/
      );
    });
  });
});
