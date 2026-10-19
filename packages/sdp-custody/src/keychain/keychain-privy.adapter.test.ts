import { PrivySigner } from "@solana/keychain-privy";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { KeychainPrivyAdapter } from "./keychain-privy.adapter";

const WALLET_ADDRESS = "11111111111111111111111111111111";

describe("privy adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts failed signer creation so subsequent calls can retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("temporary privy outage"))
      .mockResolvedValueOnce(
        Response.json({ id: "wallet-1", address: WALLET_ADDRESS, chain_type: "solana" })
      );
    const adapter = new KeychainPrivyAdapter({ appId: "app-id", appSecret: "app-secret" });

    await expect(adapter.getPublicKey("privy_wallet-1")).rejects.toThrow(
      "Privy network request failed"
    );
    await expect(adapter.getPublicKey("privy_wallet-1")).resolves.toBe(WALLET_ADDRESS);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const retryCall = fetchSpy.mock.calls[1];
    assert.isDefined(retryCall);
    expect(String(retryCall[0])).toContain("/wallets/wallet-1");
  });

  it("creates the Privy signer from its config and the unprefixed wallet id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: "wallet-1", address: WALLET_ADDRESS, chain_type: "solana" })
    );
    const createSigner = vi.spyOn(PrivySigner, "create");
    const adapter = new KeychainPrivyAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      apiBaseUrl: "https://privy.test/v1",
      requestDelayMs: 250,
    });

    await expect(adapter.getPublicKey("privy_wallet-1")).resolves.toBe(WALLET_ADDRESS);

    expect(createSigner).toHaveBeenCalledExactlyOnceWith({
      appId: "app-id",
      appSecret: "app-secret",
      walletId: "wallet-1",
      apiBaseUrl: "https://privy.test/v1",
      requestDelayMs: 250,
    });
  });

  it("reuses one signer construction across successful calls", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ id: "wallet-1", address: WALLET_ADDRESS, chain_type: "solana" })
      );
    const adapter = new KeychainPrivyAdapter({ appId: "app-id", appSecret: "app-secret" });

    const first = await adapter.getTransactionSigner("privy_wallet-1");
    const second = await adapter.getTransactionSigner("privy_wallet-1");

    expect(second).toBe(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
