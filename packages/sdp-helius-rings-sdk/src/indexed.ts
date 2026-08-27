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
    // Photon's own clock, not this process's: SDP polls on a one-minute tick, so
    // a local stamp would report the poll that noticed rather than the chain
    // state that settled it. `blockTime` is the highest slot Photon has persisted.
    indexedAt: indexerTime(response.context.blockTime),
    // The event, not the input echoed back: one signature can carry several.
    photonRef: `${txSignature}#${first.eventIndex}`,
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
