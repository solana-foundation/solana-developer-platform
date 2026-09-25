import { createECDH } from "node:crypto";
import { KeychainTurnkeyAdapter } from "@sdp/custody/keychain";
import type { Transaction, TransactionWithinSizeLimit, TransactionWithLifetime } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

type TurnkeyTransaction = Transaction & TransactionWithinSizeLimit & TransactionWithLifetime;
const DEFAULT_WALLET_PUBLIC_KEY = "1".repeat(32);

describe("turnkey adapter", () => {
  it("signs transaction message bytes via signMessages", async () => {
    const apiKey = createECDH("prime256v1");
    apiKey.generateKeys();
    // Node strips leading zero bytes from the hex private key, so ~1 in 256
    // scalars render as 31 bytes and the Turnkey stamper rejects them. Zero
    // padding restores the fixed 32-byte encoding of the same scalar.
    const adapter = new KeychainTurnkeyAdapter({
      apiPublicKey: apiKey.getPublicKey("hex", "compressed"),
      apiPrivateKey: apiKey.getPrivateKey("hex").padStart(64, "0"),
      organizationId: "org-id",
      defaultWalletId: "turnkey_private-key-id",
      defaultWalletPublicKey: DEFAULT_WALLET_PUBLIC_KEY,
    });

    const signer = await adapter.getTransactionSigner();
    const expectedSignatures = [Object.freeze({})] as Awaited<
      ReturnType<typeof signer.signMessages>
    >;
    const signMessagesSpy = vi.spyOn(signer, "signMessages").mockResolvedValue(expectedSignatures);

    const messageBytes = new Uint8Array([1, 2, 3, 4]);
    const transaction = {
      messageBytes,
      signatures: Object.freeze({}),
    } as unknown as TurnkeyTransaction;

    const signatures = await signer.signTransactions([transaction]);

    expect(signMessagesSpy).toHaveBeenCalledTimes(1);

    const [messagesArg] = signMessagesSpy.mock.calls[0];
    expect(messagesArg).toHaveLength(1);
    expect(Array.from(messagesArg[0].content)).toEqual([1, 2, 3, 4]);
    expect(messagesArg[0].content).not.toBe(messageBytes);

    expect(signatures).toEqual(expectedSignatures);
  });
});
