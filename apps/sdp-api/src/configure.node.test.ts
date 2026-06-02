import { FIELDS, generateEnv } from "@sdp/env-config";
import { describe, expect, it } from "vitest";
import { collectFromEnv, getOutPath } from "../scripts/configure";

const HEX_64 = /^[0-9a-f]{64}$/;

describe("getOutPath", () => {
  it("returns the path after --out", () => {
    expect(getOutPath(["--out", ".env"])).toBe(".env");
  });
  it("returns undefined when --out is absent", () => {
    expect(getOutPath(["--non-interactive"])).toBeUndefined();
  });
});

describe("collectFromEnv", () => {
  it("applies environment overrides", () => {
    expect(collectFromEnv({ CLERK_SECRET_KEY: "sk_x" }).CLERK_SECRET_KEY).toBe("sk_x");
  });

  it("auto-fills missing secrets with 32-byte hex", () => {
    const values = collectFromEnv({});
    expect(values.API_KEY_PEPPER).toMatch(HEX_64);
    expect(values.CUSTODY_ENCRYPTION_KEY).toMatch(HEX_64);
    expect(values.POSTGRES_PASSWORD).toMatch(HEX_64);
  });

  it("preserves a provided secret instead of regenerating it", () => {
    expect(collectFromEnv({ API_KEY_PEPPER: "fixed" }).API_KEY_PEPPER).toBe("fixed");
  });

  it("emits a provided DATABASE_URL by switching to external mode", () => {
    const env = generateEnv(collectFromEnv({ DATABASE_URL: "postgresql://u@h:5432/d" }));
    expect(env).toContain("DATABASE_URL=postgresql://u@h:5432/d");
  });

  it("generates a non-empty .env containing the required keys", () => {
    const env = generateEnv(
      collectFromEnv({
        CLERK_SECRET_KEY: "sk_test",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test",
        CLERK_ISSUER: "https://x.clerk.accounts.dev",
        CUSTODY_PRIVATE_KEY: "k",
      })
    );

    expect(env.length).toBeGreaterThan(0);
    for (const key of [
      "CLERK_SECRET_KEY",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "CLERK_ISSUER",
      "CUSTODY_PRIVATE_KEY",
      "API_KEY_PEPPER",
    ]) {
      expect(env).toContain(`${key}=`);
    }
  });

  it("emits derived fields without taking them from input", () => {
    // The interactive loop skips any field with a derive (they are computed),
    // yet generate still emits them from the values they depend on.
    const network = FIELDS.find((f) => f.key === "NEXT_PUBLIC_SOLANA_NETWORK");
    expect(network?.derive).toBeTypeOf("function");

    const env = generateEnv(collectFromEnv({ SOLANA_NETWORK: "mainnet-beta" }));
    expect(env).toContain("NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta");
  });
});
