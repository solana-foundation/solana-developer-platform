import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type { VerifyIndexedResult } from "@sdp/helius-rings";
import type { Signature } from "@solana/kit";

/**
 * Whether Photon has persisted the Rings events for one outer signature.
 *
 * A single request, not a wait: the indexing poll already retries on its own
 * schedule, and sleeping inside this call would stack that budget. Empty is
 * "not yet", not a failure — the port says so with null.
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
    // Photon's own clock, not this process's. The operation renders this as
    // when it completed, and SDP polls on a one-minute tick, so stamping the
    // local time would report the poll that noticed rather than the chain state
    // that settled it. `blockTime` is the block time of the highest slot the
    // indexer has persisted, which is the closest thing the response carries to
    // "when this became indexed" — and on a lagging indexer it is the more
    // honest of the two by a wider margin.
    indexedAt: indexerTime(response.context.blockTime),
    // The event, not the input echoed back: one signature can carry several
    // Rings events, and the index is what distinguishes them.
    photonRef: `${txSignature}#${first.eventIndex}`,
  };
}

/**
 * Unix seconds to ISO, falling back to now.
 *
 * A local validator reports a blockTime of zero, and dating a devnet operation
 * to 1970 would be a worse lie than the one this replaces.
 */
function indexerTime(blockTime: bigint): string {
  const seconds = Number(blockTime);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return new Date().toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}
