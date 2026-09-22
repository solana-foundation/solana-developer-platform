import { describe, expect, it } from "vitest";
import type { DemoConfig } from "./env";
import { demoConfigSchema } from "./env";

const baseConfig: DemoConfig = {
  SDP_API_BASE_URL: "http://127.0.0.1:8787",
  SDP_API_KEY: "test-api-key",
  DEMO_WALLET_PRIVATE_KEY: "test-private-key",
  SOLANA_CLUSTER: "devnet",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
};

describe("demo configuration", () => {
  it("allows cleartext only for loopback SDP API URLs", () => {
    expect(
      demoConfigSchema.safeParse({
        ...baseConfig,
        SDP_API_BASE_URL: "http://127.0.0.1:8787",
      }).success
    ).toBe(true);
    expect(
      demoConfigSchema.safeParse({
        ...baseConfig,
        SDP_API_BASE_URL: "http://localhost:8787",
      }).success
    ).toBe(true);
    expect(
      demoConfigSchema.safeParse({
        ...baseConfig,
        SDP_API_BASE_URL: "https://api.example.test",
      }).success
    ).toBe(true);
  });

  it("refuses a cleartext remote SDP API URL", () => {
    const result = demoConfigSchema.safeParse({
      ...baseConfig,
      SDP_API_BASE_URL: "http://api.example.test",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("must use https");
    }
  });
});
