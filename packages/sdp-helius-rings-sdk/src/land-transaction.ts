import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  getBase64Codec,
  getTransactionEncoder,
  type Signature,
  type Transaction,
} from "@solana/kit";

/** The custody callbacks a bring-up step signs and broadcasts through, plus the client that confirms. */
export interface LandTransactionDeps {
  readonly client: ZolanaClient;
  /**
   * `owner` is passed alongside the bytes because custody has to be told which
   * key to sign with. A gateway serves every wallet in its tenant, so leaving
   * the choice to custody's default would sign the wrong wallet's transaction.
   */
  readonly signTransaction: (unsignedTxBase64: string, owner: string) => Promise<string>;
  readonly submitTransaction: (signedTxBase64: string) => Promise<string>;
}

/**
 * Signs through custody, broadcasts, and waits for the chain to accept it.
 * The one place bring-up bytes reach `deps.signTransaction`, shared with ring
 * bring-up in `provision-ring.ts`.
 */
export async function landTransaction(
  deps: LandTransactionDeps,
  transaction: Transaction,
  owner: string
): Promise<string> {
  const unsigned = getBase64Codec().decode(getTransactionEncoder().encode(transaction));
  const signed = await deps.signTransaction(unsigned, owner);
  const signature = await deps.submitTransaction(signed);

  // SAFETY: submitTransaction returns the base58 signature the broadcasting RPC reported.
  await deps.client.confirmTransaction(signature as Signature);

  return signature;
}
