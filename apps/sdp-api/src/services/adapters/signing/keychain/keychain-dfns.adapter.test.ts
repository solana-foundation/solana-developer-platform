import { KeychainDfnsAdapter } from "@/services/adapters/signing/keychain/keychain-dfns.adapter";
import type { DfnsApiClient } from "@sdp/keychain-dfns";
import { describe, expect, it, vi } from "vitest";

describe("dfns adapter", () => {
  const expectedSignature = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
  const signatureHex = `0x${Array.from(expectedSignature)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;

  it("resolves public key from DFNS wallet", async () => {
    const getWallet = vi.fn().mockResolvedValue({
      id: "wa_test",
      network: "SolanaDevnet",
      address: "11111111111111111111111111111111",
      signingKey: { id: "key_test" },
    });

    const adapter = new KeychainDfnsAdapter({
      client: {
        wallets: {
          getWallet,
        },
        keySignatures: {
          createSignature: vi.fn().mockResolvedValue({
            id: "sig_test",
            status: "Signed",
            signedData: signatureHex,
          }),
          getSignature: vi.fn().mockResolvedValue({
            id: "sig_test",
            status: "Signed",
            signedData: signatureHex,
          }),
        },
      } as DfnsApiClient,
      defaultWalletId: "dfns_wa_test",
    });

    const publicKey = await adapter.getPublicKey();
    expect(publicKey).toBe("11111111111111111111111111111111");
    expect(getWallet).toHaveBeenCalledWith({ walletId: "wa_test" });
  });

  it("returns completed signatures for DFNS message signing", async () => {
    const getWallet = vi.fn().mockResolvedValue({
      id: "wa_test",
      network: "SolanaDevnet",
      address: "11111111111111111111111111111111",
      signingKey: { id: "key_test" },
    });
    const createSignature = vi.fn().mockResolvedValue({
      id: "sig_test",
      status: "Signed",
      signedData: signatureHex,
    });

    const adapter = new KeychainDfnsAdapter({
      client: {
        wallets: {
          getWallet,
        },
        keySignatures: {
          createSignature,
          getSignature: vi.fn().mockResolvedValue({
            id: "sig_test",
            status: "Signed",
            signedData: signatureHex,
          }),
        },
      } as DfnsApiClient,
      defaultWalletId: "dfns_wa_test",
    });

    const result = await adapter.sign({
      message: new Uint8Array([1, 2, 3]),
      signers: [],
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed" || !result.signatures) {
      throw new Error("Expected completed result");
    }

    expect(result.signatures.size).toBeGreaterThan(0);
    expect(createSignature).toHaveBeenCalledWith({
      keyId: "key_test",
      body: {
        kind: "Message",
        message: "0x010203",
        network: "SolanaDevnet",
      },
    });
  });
});
