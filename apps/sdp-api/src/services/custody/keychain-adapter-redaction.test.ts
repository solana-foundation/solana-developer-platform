import { KeychainCoinbaseAdapter, KeychainUtilaAdapter } from "@sdp/custody/keychain";
import { createCdpSigner } from "@solana/keychain-cdp";
import { createUtilaSigner } from "@solana/keychain-utila";
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@solana/keychain-utila", () => ({
  createUtilaSigner: vi.fn(),
}));

vi.mock("@solana/keychain-cdp", () => ({
  createCdpSigner: vi.fn(),
}));

const mockedCreateUtilaSigner = vi.mocked(createUtilaSigner);
const mockedCreateCdpSigner = vi.mocked(createCdpSigner);

const LEAKED_TOKEN = "eyJhbGciOiJSUzI1NiJ9.leaked-token";
const SIGN_REQUEST = {
  message: new Uint8Array([1, 2, 3]),
  signers: ["11111111111111111111111111111111" as Address],
};

describe("keychain adapter error redaction", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("redacts credentials embedded in utila signing failures", async () => {
    mockedCreateUtilaSigner.mockRejectedValue(
      new Error(`Utila API error 401: {"authorization":"Bearer ${LEAKED_TOKEN}"}`)
    );

    const adapter = new KeychainUtilaAdapter({
      serviceAccountEmail: "service-account@example.com",
      serviceAccountPrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      vaultId: "vault_123",
      network: "networks/solana-devnet",
      defaultWalletId: "utila_wallet_1",
    });

    const result = await adapter.sign(SIGN_REQUEST);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("[REDACTED]");
    expect(result.error).not.toContain(LEAKED_TOKEN);
  });

  it("redacts credentials embedded in base keychain signing failures", async () => {
    mockedCreateCdpSigner.mockResolvedValue({
      address: "11111111111111111111111111111111",
      isAvailable: async () => true,
      signMessages: () => {
        throw new Error(`CDP API error 401: {"walletSecret":"${LEAKED_TOKEN}"}`);
      },
    } as unknown as Awaited<ReturnType<typeof createCdpSigner>>);

    const adapter = new KeychainCoinbaseAdapter({
      apiKeyId: "api-key-id",
      apiKeySecret: "api-key-secret",
      walletSecret: "wallet-secret",
      defaultWalletId: "cdp_11111111111111111111111111111111",
    });

    const result = await adapter.sign(SIGN_REQUEST);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("[REDACTED]");
    expect(result.error).not.toContain(LEAKED_TOKEN);
  });
});
