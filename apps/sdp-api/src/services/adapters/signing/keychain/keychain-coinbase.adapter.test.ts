import { generateKeyPairSync } from "node:crypto";
import { KeychainCoinbaseAdapter } from "@sdp/custody/keychain";
import { afterEach, describe, expect, it, vi } from "vitest";

const WALLET_ADDRESS = "11111111111111111111111111111111";

function createCoinbaseSecrets(): { apiKeySecret: string; walletSecret: string } {
  const ed25519 = generateKeyPairSync("ed25519");
  const seed = ed25519.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const publicKey = ed25519.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    apiKeySecret: Buffer.concat([seed, publicKey]).toString("base64"),
    walletSecret: p256.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

describe("coinbase adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts failed signer creation so subsequent calls can retry", async () => {
    const adapter = new KeychainCoinbaseAdapter({
      apiKeyId: "api-key-id",
      ...createCoinbaseSecrets(),
    });
    const importKeySpy = vi
      .spyOn(globalThis.crypto.subtle, "importKey")
      .mockRejectedValueOnce(new Error("temporary crypto failure"));

    await expect(adapter.getPublicKey(`cdp_${WALLET_ADDRESS}`)).rejects.toThrow();
    const callsAfterFailure = importKeySpy.mock.calls.length;
    await expect(adapter.getPublicKey(`cdp_${WALLET_ADDRESS}`)).resolves.toBe(WALLET_ADDRESS);

    expect(importKeySpy.mock.calls.length).toBeGreaterThan(callsAfterFailure);
  });

  it("reuses one signer construction across successful calls", async () => {
    const adapter = new KeychainCoinbaseAdapter({
      apiKeyId: "api-key-id",
      ...createCoinbaseSecrets(),
    });
    const importKeySpy = vi.spyOn(globalThis.crypto.subtle, "importKey");

    const first = await adapter.getTransactionSigner(`cdp_${WALLET_ADDRESS}`);
    const callsAfterFirst = importKeySpy.mock.calls.length;
    const second = await adapter.getTransactionSigner(`cdp_${WALLET_ADDRESS}`);

    expect(second).toBe(first);
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(importKeySpy).toHaveBeenCalledTimes(callsAfterFirst);
  });
});
