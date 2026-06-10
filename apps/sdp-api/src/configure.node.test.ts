import { FIELDS, generateEnv } from "@sdp/env-config";
import { describe, expect, it } from "vitest";
import { collectFromEnv, getOutPath, resolveMultiSelectTokens } from "../scripts/configure";

const HEX_64 = /^[0-9a-f]{64}$/;

describe("resolveMultiSelectTokens", () => {
  const opts = [
    { value: "local", label: "local" },
    { value: "fireblocks", label: "Fireblocks" },
    { value: "privy", label: "Privy" },
  ];

  it("resolves 1-based indices and option values, preserving order", () => {
    expect(resolveMultiSelectTokens(["2", "privy"], opts)).toEqual({
      values: ["fireblocks", "privy"],
    });
  });

  it("dedupes repeated selections", () => {
    expect(resolveMultiSelectTokens(["local", "1", "local"], opts)).toEqual({ values: ["local"] });
  });

  it("returns the first unknown token as an error", () => {
    expect(resolveMultiSelectTokens(["local", "bogus"], opts)).toEqual({ error: "bogus" });
  });

  it("treats an out-of-range index as an error", () => {
    expect(resolveMultiSelectTokens(["9"], opts)).toEqual({ error: "9" });
  });
});

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

  it("auto-fills missing secrets in each field's encoding", () => {
    const values = collectFromEnv({});
    expect(values.API_KEY_PEPPER).toMatch(HEX_64);
    expect(values.POSTGRES_PASSWORD).toMatch(HEX_64);
    expect(Buffer.from(values.CUSTODY_ENCRYPTION_KEY, "base64")).toHaveLength(32);
  });

  it("preserves a provided secret instead of regenerating it", () => {
    expect(collectFromEnv({ API_KEY_PEPPER: "fixed" }).API_KEY_PEPPER).toBe("fixed");
  });

  it("emits a provided DATABASE_URL by switching to external mode", () => {
    const env = generateEnv(collectFromEnv({ DATABASE_URL: "postgresql://u@h:5432/d" }));
    expect(env).toContain("DATABASE_URL=postgresql://u@h:5432/d");
  });

  it("still emits POSTGRES_PASSWORD with an external database", () => {
    // External mode hides the field, but compose's bundled Postgres still needs it.
    const env = generateEnv(collectFromEnv({ DATABASE_URL: "postgresql://u@h:5432/d" }));
    expect(env).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{64}$/m);
  });

  it("emits POSTGRES_PASSWORD for an external DB even when manual mode is set", () => {
    // Manual mode is a bundled-DB choice; it must not suppress the password the
    // bundled container still requires under an external database.
    const env = generateEnv(
      collectFromEnv({
        DATABASE_URL: "postgresql://u@h:5432/d",
        POSTGRES_PASSWORD_MODE: "manual",
      })
    );
    expect(env).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{64}$/m);
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

  it("auto-fills the Postgres password by default", () => {
    expect(collectFromEnv({}).POSTGRES_PASSWORD).toMatch(HEX_64);
  });

  it("does not auto-fill the Postgres password in manual mode", () => {
    const values = collectFromEnv({ POSTGRES_PASSWORD_MODE: "manual" });
    expect(values.POSTGRES_PASSWORD).toBe("");
  });

  it("derives SIGNING_PROVIDERS from a bare SIGNING_PROVIDER", () => {
    expect(collectFromEnv({ SIGNING_PROVIDER: "fireblocks" }).SIGNING_PROVIDERS).toBe("fireblocks");
  });

  it("picks the first listed provider as the default when only SIGNING_PROVIDERS is given", () => {
    const values = collectFromEnv({ SIGNING_PROVIDERS: "fireblocks,privy" });
    expect(values.SIGNING_PROVIDER).toBe("fireblocks");
  });

  it("picks the first listed provider even when the field default is also listed", () => {
    const values = collectFromEnv({ SIGNING_PROVIDERS: "fireblocks,local" });
    expect(values.SIGNING_PROVIDER).toBe("fireblocks");
  });

  it("emits the self_hosted deployment mode constant", () => {
    expect(generateEnv(collectFromEnv({}))).toContain("SDP_DEPLOYMENT_MODE=self_hosted");
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
