import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type { VerifyIndexedResult } from "@sdp/helius-rings";
import type { Signature } from "@solana/kit";

/**
 * Whether Photon has persisted the Rings events for one outer signature. A
 * single request, not a wait: the indexing poll already retries on its own
 * schedule. Empty is "not yet", which the port says with null.
 */
export async function verifyRingsIndexed(
  client: ZolanaClient,
  txSignature: string
): Promise<VerifyIndexedResult | null> {
  const response = await client.getShieldedTransactionsBySignature(txSignature as Signature);
  const [first] = response.transactions;
  if (!first) {
    return null;
  }

  return {
    indexedAt: indexerTime(response.context.blockTime),
    photonRef: `${txSignature}#${first.eventIndex}`,
    slot: first.transaction.slot.toString(),
  };
}

/**
 * Unix seconds to ISO, falling back to now: a local validator reports a
 * blockTime of zero, and dating a devnet operation to 1970 would be worse.
 */
function indexerTime(blockTime: bigint): string {
  const seconds = Number(blockTime);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return new Date().toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}
