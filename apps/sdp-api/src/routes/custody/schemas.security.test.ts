import { describe, expect, it } from "vitest";
import { assertNoExistingProviderObjectSelector } from "./handlers/provider";
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
  it.each(hostedProviderRequests)("does not accept a client endpoint for $provider", (request) => {
    const parsed = schema.safeParse({
      ...request,
      apiBaseUrl: "https://untrusted.example",
    });

    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("apiBaseUrl");
    }
  });

  it.each(
    existingProviderObjectRequests
  )("does not include an existing $provider object selector", (request) => {
    const parsed = schema.parse(request);
    expect(parsed).not.toHaveProperty("walletAddress");
    expect(parsed).not.toHaveProperty("walletId");
    expect(parsed).not.toHaveProperty("privateKeyId");
    expect(parsed).not.toHaveProperty("signingKeyId");
  });
});

describe("hosted custody provider object selection", () => {
  it.each(
    existingProviderObjectRequests
  )("rejects client selection of an existing $provider object", (request) => {
    expect(() => assertNoExistingProviderObjectSelector(request)).toThrow(
      /cannot select an existing wallet/
    );
  });

  it("preserves ordinary platform-managed provisioning requests", () => {
    expect(() =>
      assertNoExistingProviderObjectSelector({
        provider: "coinbase_cdp",
        network: "solana-devnet",
        walletLabel: "Treasury",
      })
    ).not.toThrow();
  });

  it.each([
    "__proto__",
    "constructor",
  ])("defers the unknown provider %s to schema validation", (provider) => {
    const request = { provider, walletId: "wallet_from_another_tenant" };

    expect(() => assertNoExistingProviderObjectSelector(request)).not.toThrow();
    expect(initializeSigningSchema.safeParse(request).success).toBe(false);
    expect(switchSigningSchema.safeParse(request).success).toBe(false);
  });
});
