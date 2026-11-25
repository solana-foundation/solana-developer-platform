import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import type { DfnsApiClient } from "#/providers/dfns/client";
import { KeychainDfnsAdapter } from "./keychain.adapter";

const { address: WALLET_ADDRESS } = await generateKeyPairSigner();

function notCalledWhenResolving(): Promise<never> {
  return Promise.reject(new Error("Resolving a signer reads only wallets.getWallet"));
}

function clientReading(getWallet: DfnsApiClient["wallets"]["getWallet"]): DfnsApiClient {
  return {
    wallets: {
      getWallet,
      listWallets: notCalledWhenResolving,
      createWallet: notCalledWhenResolving,
    },
    keySignatures: {
      createSignature: notCalledWhenResolving,
      getSignature: notCalledWhenResolving,
    },
  };
}

describe("dfns adapter", () => {
  it("evicts failed signer creation so subsequent calls can retry", async () => {
    const getWallet = vi
      .fn<DfnsApiClient["wallets"]["getWallet"]>()
      .mockRejectedValueOnce(new Error("temporary dfns outage"))
      .mockResolvedValueOnce({
        id: "wa-1",
        network: "SolanaDevnet",
        address: WALLET_ADDRESS,
        signingKey: { id: "key-1" },
      });
    const adapter = new KeychainDfnsAdapter({ client: clientReading(getWallet) });

    await expect(adapter.getPublicKey("dfns_wa-1")).rejects.toThrow("Failed to fetch");
    await expect(adapter.getPublicKey("dfns_wa-1")).resolves.toBe(WALLET_ADDRESS);

    expect(getWallet).toHaveBeenCalledTimes(2);
  });

  it("hands out one signer per wallet and reads the wallet once", async () => {
    const getWallet = vi.fn<DfnsApiClient["wallets"]["getWallet"]>().mockResolvedValue({
      id: "wa-1",
      network: "SolanaDevnet",
      address: WALLET_ADDRESS,
      signingKey: { id: "key-1" },
    });
    const adapter = new KeychainDfnsAdapter({ client: clientReading(getWallet) });

    const first = await adapter.getTransactionSigner("dfns_wa-1");
    const second = await adapter.getTransactionSigner("dfns_wa-1");

    expect(second).toBe(first);
    expect(getWallet).toHaveBeenCalledTimes(1);
  });
});
