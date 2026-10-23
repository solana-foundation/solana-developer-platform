import { getSignatureStatuses, type SignatureStatusInfo, type SolanaRpc } from "@sdp/rpc/solana";
import type { Signature, Slot } from "@solana/kit";

/** A batch row whose blockhash a height read shows expired while its batch status was null. */
export interface ExpiredUnseenSignature {
  /** The row's position in the batch. */
  index: number;
  signature: Signature;
}

/**
 * Re-read the status of every expired, unseen signature from a node at least as current as the
 * height read that proved the expiry (`minContextSlot`), as sponsorship budget reconciliation
 * does. Per-request pool failover can answer the batch statuses from an endpoint behind the one
 * that answered the height, so a null batch status alone never proves a transaction absent.
 *
 * @param rpc - The cluster's pool client.
 * @param statuses - The batch statuses, by row index.
 * @param expired - The rows to re-read.
 * @param minContextSlot - The slot the height read was answered at.
 * @returns The batch statuses with each re-read status in place.
 * @throws When no node at `minContextSlot` answered; the caller leaves those rows unjudged.
 */
export async function reReadExpiredStatuses(
  rpc: SolanaRpc,
  statuses: ReadonlyArray<SignatureStatusInfo | null>,
  expired: readonly ExpiredUnseenSignature[],
  minContextSlot: Slot
): Promise<Array<SignatureStatusInfo | null>> {
  const reRead = [...statuses];
  if (expired.length === 0) return reRead;
  const current = await getSignatureStatuses(
    rpc,
    expired.map(({ signature }) => signature),
    { searchTransactionHistory: true, minContextSlot }
  );
  for (const [position, { index }] of expired.entries()) {
    reRead[index] = current[position] ?? null;
  }
  return reRead;
}
