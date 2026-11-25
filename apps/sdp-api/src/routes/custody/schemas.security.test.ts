import { describe, expect, it } from "vitest";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { initializeSigningSchema } from "./schemas";

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
  { provider: "coinbase_cdp", walletAddress: TEST_SOLANA_ADDRESSES.wallet1 },
  { provider: "para", walletId: "wallet_from_another_tenant" },
  { provider: "turnkey", privateKeyId: "key_from_another_tenant" },
  { provider: "dfns", walletId: "wallet_from_another_tenant" },
  { provider: "dfns", signingKeyId: "key_from_another_tenant" },
  { provider: "ibm_haven", walletId: "wallet_from_another_tenant" },
  { provider: "ibm_haven", signingKeyId: "key_from_another_tenant" },
  { provider: "anchorage", walletId: "wallet_from_another_tenant" },
] as const;

describe("custody initialize endpoint selection", () => {
  it.each(hostedProviderRequests)("rejects a client endpoint for $provider", (request) => {
    const parsed = initializeSigningSchema.safeParse({
      ...request,
      apiBaseUrl: "https://untrusted.example",
    });

    expect(parsed.success).toBe(false);
  });

  it.each(existingProviderObjectRequests)(
    "rejects client selection of an existing $provider object",
    (request) => {
      expect(initializeSigningSchema.safeParse(request).success).toBe(false);
    }
  );

  it.each([
    { provider: "coinbase_cdp", network: "solana" },
    { provider: "anchorage", network: "solana" },
    { provider: "dfns", network: "Solana" },
    { provider: "ibm_haven", network: "Solana" },
  ] as const)("refuses a $provider request that chooses its network", ({ provider, network }) => {
    const request = { provider, walletLabel: "Treasury" };

    expect(initializeSigningSchema.safeParse(request).success).toBe(true);
    expect(initializeSigningSchema.safeParse({ ...request, network }).success).toBe(false);
  });

  it.each(["__proto__", "constructor"])("rejects the unknown provider %s", (provider) => {
    const request = { provider, walletId: "wallet_from_another_tenant" };

    expect(initializeSigningSchema.safeParse(request).success).toBe(false);
  });
});
