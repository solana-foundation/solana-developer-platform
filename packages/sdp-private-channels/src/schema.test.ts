import { describe, expect, it } from "vitest";
import { SANDBOX_DEFAULTS } from "./constants";
import { privateChannelInstanceInputSchema } from "./schema";

describe("privateChannelInstanceInputSchema", () => {
  it("accepts the sandbox defaults", () => {
    const result = privateChannelInstanceInputSchema.safeParse(SANDBOX_DEFAULTS);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.gatewayUrl).toBe(SANDBOX_DEFAULTS.gatewayUrl);
    expect(result.data.authUrl).toBe(SANDBOX_DEFAULTS.authUrl);
  });

  it("rejects an empty gateway URL", () => {
    const result = privateChannelInstanceInputSchema.safeParse({
      ...SANDBOX_DEFAULTS,
      gatewayUrl: "",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const fieldErrors = result.error.flatten().fieldErrors;
    expect(fieldErrors.gatewayUrl?.[0]).toMatch(/required/i);
  });

  it("accepts an omitted legacy chain RPC URL", () => {
    const { chainRpcUrl: _legacyChainRpcUrl, ...input } = SANDBOX_DEFAULTS;
    const result = privateChannelInstanceInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.chainRpcUrl).toBe("");
  });

  it("accepts an explicitly empty legacy chain RPC URL from persisted instances", () => {
    const result = privateChannelInstanceInputSchema.safeParse({
      ...SANDBOX_DEFAULTS,
      chainRpcUrl: "",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.chainRpcUrl).toBe("");
  });

  it("rejects a non-http legacy chain RPC URL", () => {
    const result = privateChannelInstanceInputSchema.safeParse({
      ...SANDBOX_DEFAULTS,
      chainRpcUrl: "ftp://example.com",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors.chainRpcUrl?.[0]).toMatch(/http\/https/i);
  });

  it("rejects an escrow program ID that is not base58", () => {
    const result = privateChannelInstanceInputSchema.safeParse({
      ...SANDBOX_DEFAULTS,
      escrowProgramId: "not-a-base58-address",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors.escrowProgramId?.[0]).toMatch(/base58/i);
  });

  it("requires a non-empty auth URL", () => {
    const result = privateChannelInstanceInputSchema.safeParse({
      ...SANDBOX_DEFAULTS,
      authUrl: "",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors.authUrl?.[0]).toMatch(/required/i);
  });

  it("rejects a non-http protocol for the auth URL", () => {
    const result = privateChannelInstanceInputSchema.safeParse({
      ...SANDBOX_DEFAULTS,
      authUrl: "ftp://auth.example",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors.authUrl?.[0]).toMatch(/http\/https/i);
  });

  it("trims whitespace-only values into empty errors", () => {
    const result = privateChannelInstanceInputSchema.safeParse({
      ...SANDBOX_DEFAULTS,
      escrowInstanceAddr: "   ",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors.escrowInstanceAddr?.[0]).toMatch(/required/i);
  });
});
