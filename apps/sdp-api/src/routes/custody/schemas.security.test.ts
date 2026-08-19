import { describe, expect, it } from "vitest";
import { initializeSigningSchema, switchSigningSchema } from "./schemas";

const hostedProviderRequests = [
  { provider: "privy" },
  { provider: "coinbase_cdp" },
  { provider: "para" },
  { provider: "turnkey" },
  { provider: "dfns" },
  { provider: "ibm_haven" },
  { provider: "anchorage" },
] as const;

const existingProviderObjectRequests = [
  { provider: "coinbase_cdp", walletAddress: "11111111111111111111111111111111" },
  { provider: "para", walletId: "wallet_from_another_tenant" },
  { provider: "turnkey", privateKeyId: "key_from_another_tenant" },
  { provider: "dfns", walletId: "wallet_from_another_tenant" },
  { provider: "dfns", signingKeyId: "key_from_another_tenant" },
  { provider: "ibm_haven", walletId: "wallet_from_another_tenant" },
  { provider: "ibm_haven", signingKeyId: "key_from_another_tenant" },
  { provider: "anchorage", walletId: "wallet_from_another_tenant" },
] as const;

describe.each([
  ["initialize", initializeSigningSchema],
  ["switch", switchSigningSchema],
] as const)("custody %s endpoint selection", (_operation, schema) => {
  it.each(hostedProviderRequests)("rejects a client endpoint for $provider", (request) => {
    const parsed = schema.safeParse({
      ...request,
      apiBaseUrl: "https://untrusted.example",
    });

    expect(parsed.success).toBe(false);
  });

  it.each(existingProviderObjectRequests)(
    "rejects client selection of an existing $provider object",
    (request) => {
      expect(schema.safeParse(request).success).toBe(false);
    }
  );

  it("preserves ordinary platform-managed provisioning requests", () => {
    const parsed = schema.safeParse({
      provider: "coinbase_cdp",
      network: "solana-devnet",
      walletLabel: "Treasury",
    });

    expect(parsed.success).toBe(true);
  });

  it.each(["__proto__", "constructor"])("rejects the unknown provider %s", (provider) => {
    const request = { provider, walletId: "wallet_from_another_tenant" };

    expect(schema.safeParse(request).success).toBe(false);
  });
});
