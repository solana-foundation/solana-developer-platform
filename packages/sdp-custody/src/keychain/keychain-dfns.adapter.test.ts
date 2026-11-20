import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import type { DfnsApiClient, DfnsWallet } from "#/dfns/client";
import { KeychainDfnsAdapter } from "./keychain-dfns.adapter";

const { address: WALLET_ADDRESS } = await generateKeyPairSigner();

function clientReading(getWallet: (request: { walletId: string }) => Promise<DfnsWallet>) {
  // SAFETY: resolving a signer reads only `wallets.getWallet` from the client.
  return { wallets: { getWallet } } as unknown as DfnsApiClient;
}

describe("dfns adapter", () => {
  it("evicts failed signer creation so subsequent calls can retry", async () => {
    const getWallet = vi
      .fn<(request: { walletId: string }) => Promise<DfnsWallet>>()
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

  it("reuses one signer construction across successful calls", async () => {
    const getWallet = vi
      .fn<(request: { walletId: string }) => Promise<DfnsWallet>>()
      .mockResolvedValue({
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
