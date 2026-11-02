import { generateKeyPairSync } from "node:crypto";
import { createSignableMessage, generateKeyPairSigner } from "@solana/kit";
import type { MockInstance } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeychainFireblocksAdapter } from "./keychain-fireblocks.adapter";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CONFIG = {
  apiKey: "api-key",
  apiSecretPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  vaultAccountId: "default-vault",
};
const WALLET_ADDRESS = "11111111111111111111111111111111";

/** Every argument every console sink received, as one searchable string. */
function collectLogLines(...sinks: MockInstance[]): string {
  return sinks
    .flatMap((sink) => sink.mock.calls)
    .map((call) => call.map((argument) => JSON.stringify(argument)).join(" "))
    .join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fireblocks adapter", () => {
  it("evicts failed signer initialization so subsequent calls can retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("temporary fireblocks outage"))
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: WALLET_ADDRESS }] }));
    const adapter = new KeychainFireblocksAdapter(CONFIG);

    await expect(adapter.getPublicKey("fb_vault-1")).rejects.toThrow(
      "Fireblocks network request failed"
    );
    await expect(adapter.getPublicKey("fb_vault-1")).resolves.toBe(WALLET_ADDRESS);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [url] of fetchSpy.mock.calls) {
      expect(String(url)).toBe(
        "https://api.fireblocks.io/v1/vault/accounts/vault-1/SOL/addresses_paginated"
      );
    }
  });

  it("keeps real Fireblocks request and response bodies off every console sink", async () => {
    const methods = ["debug", "log", "info", "warn", "error"] as const;
    const sinks = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const wallet = await generateKeyPairSigner();
    const message = createSignableMessage("secret-signing-payload");
    const [expectedSignatures] = await wallet.signMessages([message]);
    const signatureHex = Buffer.from(expectedSignatures[wallet.address]).toString("hex");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: wallet.address }] }))
      .mockResolvedValueOnce(Response.json({ id: "tx-1", note: "response-secret-value" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "COMPLETED",
          signedMessages: [{ signature: { fullSig: signatureHex } }],
        })
      )
      .mockRejectedValueOnce(new TypeError("fireblocks is unavailable"));
    const adapter = new KeychainFireblocksAdapter(CONFIG);
    const signer = await adapter.getTransactionSigner();

    await expect(signer.signMessages([message])).resolves.toEqual([expectedSignatures]);
    await expect(signer.signMessages([message])).rejects.toThrow(
      "Fireblocks network request failed"
    );

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const payloadHex = Buffer.from(message.content).toString("hex");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.fireblocks.io/v1/transactions",
      expect.objectContaining({ method: "POST", body: expect.stringContaining(payloadHex) })
    );
    const logged = collectLogLines(...sinks);
    expect(logged).not.toContain("secret-signing-payload");
    expect(logged).not.toContain(payloadHex);
    expect(logged).not.toContain("response-secret-value");
    expect(logged).not.toContain(signatureHex);
    expect(logged).not.toContain("fireblocks is unavailable");
  });
});
