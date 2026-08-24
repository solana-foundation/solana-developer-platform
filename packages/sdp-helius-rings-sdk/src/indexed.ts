import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type { VerifyIndexedResult } from "@sdp/helius-rings";
import type { Signature } from "@solana/kit";

/**
 * Asks Photon whether it has indexed one signature yet.
 *
 * A single lookup by signature, never a rebuild and never a scan: the operation
 * already knows which transaction it is waiting for, and this is the one query
 * that answers it directly. The caller polls; nothing here retries.
 */
export async function verifyRingsIndexed(
  client: Pick<ZolanaClient, "getShieldedTransactionsBySignature">,
  signature: string
): Promise<VerifyIndexedResult | null> {
  const response = await client.getShieldedTransactionsBySignature(signature as Signature);

  const first = response.transactions[0];
  if (!first) {
    // Null rather than an error: "not yet" is the expected answer for most of
    // an operation's time in `indexing`, and the poll is what decides when
    // waiting has gone on too long.
    return null;
  }

  return {
    // Photon reports the slot it indexed, not a wall-clock time. The slot is
    // the durable fact; the timestamp is when SDP learned it, which is what the
    // operation's own timeline is measured in.
    indexedAt: new Date().toISOString(),
    photonRef: `event:${first.eventIndex}`,
    // Carried as its own field rather than only inside the reference string:
    // this is what the next read gates on, and parsing it back out of a label
    // would make a load-bearing value depend on that label's formatting.
    slot: first.transaction.slot.toString(),
  };
}
