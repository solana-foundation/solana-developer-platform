import { generateEnv } from "@sdp/env-config";
import { describe, expect, it } from "vitest";
import { collectFromEnv } from "../scripts/configure";

const HEX_64 = /^[0-9a-f]{64}$/;

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

  it("generates a non-empty .env containing the required keys", () => {
    const env = generateEnv(
      collectFromEnv({
        CLERK_SECRET_KEY: "sk_test",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test",
        CLERK_ISSUER: "https://x.clerk.accounts.dev",
        FEE_PAYER_PRIVATE_KEY: "k",
      })
    );

    expect(env.length).toBeGreaterThan(0);
    for (const key of [
      "CLERK_SECRET_KEY",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "CLERK_ISSUER",
      "FEE_PAYER_PRIVATE_KEY",
      "API_KEY_PEPPER",
    ]) {
      expect(env).toContain(`${key}=`);
    }
  });
});
