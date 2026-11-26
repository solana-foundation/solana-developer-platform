import { generateKeyPairSync } from "node:crypto";
import { SignerErrorCode } from "@solana/keychain-core";
import { generateKeyPairSigner } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeychainCoinbaseAdapter } from "./keychain.adapter";

const { address: WALLET_ADDRESS } = await generateKeyPairSigner();

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
    vi.spyOn(globalThis.crypto.subtle, "importKey").mockRejectedValueOnce(
      new Error("temporary crypto failure")
    );

    await expect(adapter.getPublicKey(`cdp_${WALLET_ADDRESS}`)).rejects.toMatchObject({
      code: SignerErrorCode.CONFIG_ERROR,
    });
    await expect(adapter.getPublicKey(`cdp_${WALLET_ADDRESS}`)).resolves.toBe(WALLET_ADDRESS);
  });

  it("hands out one signer per wallet across successful calls", async () => {
    const adapter = new KeychainCoinbaseAdapter({
      apiKeyId: "api-key-id",
      ...createCoinbaseSecrets(),
    });

    const first = await adapter.getTransactionSigner(`cdp_${WALLET_ADDRESS}`);
    const second = await adapter.getTransactionSigner(`cdp_${WALLET_ADDRESS}`);

    expect(second).toBe(first);
  });
});
