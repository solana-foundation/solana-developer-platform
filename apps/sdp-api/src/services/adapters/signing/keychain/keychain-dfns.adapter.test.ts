import type { DfnsApiClient, DfnsWallet } from "@sdp/custody/dfns";
import { KeychainDfnsAdapter } from "@sdp/custody/keychain";
import { describe, expect, it, vi } from "vitest";

const WALLET_ADDRESS = "11111111111111111111111111111111";

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
    const client = { wallets: { getWallet } } as unknown as DfnsApiClient;
    const adapter = new KeychainDfnsAdapter({ client });

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
    const client = { wallets: { getWallet } } as unknown as DfnsApiClient;
    const adapter = new KeychainDfnsAdapter({ client });

    const first = await adapter.getTransactionSigner("dfns_wa-1");
    const second = await adapter.getTransactionSigner("dfns_wa-1");

    expect(second).toBe(first);
    expect(getWallet).toHaveBeenCalledTimes(1);
  });
});
