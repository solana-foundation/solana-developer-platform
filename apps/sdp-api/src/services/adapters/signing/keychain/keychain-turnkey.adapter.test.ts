import { KeychainTurnkeyAdapter } from "@/services/adapters/signing/keychain/keychain-turnkey.adapter";
import type {
  Transaction,
  TransactionWithLifetime,
  TransactionWithinSizeLimit,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

type TurnkeyTransaction = Transaction & TransactionWithinSizeLimit & TransactionWithLifetime;

describe("KeychainTurnkeyAdapter", () => {
  it("signs transaction message bytes via signMessages", async () => {
    const adapter = new KeychainTurnkeyAdapter({
      apiPublicKey: "public-key",
      apiPrivateKey: "private-key",
      organizationId: "org-id",
      defaultWalletId: "turnkey_private-key-id",
      defaultWalletPublicKey: "11111111111111111111111111111111",
    });

    const signer = await adapter.getTransactionSigner();
    const expectedSignatures = [Object.freeze({})] as Awaited<ReturnType<typeof signer.signMessages>>;
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
