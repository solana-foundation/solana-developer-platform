/**
 * What a broadcast funding transfer did, as far as the chain can say.
 *
 * A claim row with `funding_tx` set is written straight after broadcast, before
 * anything confirms, so "set" is not "landed". Two readers need the chain's
 * answer before acting on such a row: the reconciler, deciding whether a
 * receipt past its blockhash can be deleted, and reclaim, deciding whether it
 * may take the row over. One classification serves both, so they cannot drift.
 */

import { getSignatureStatuses, type SignatureStatusInfo, type SolanaRpc } from "@sdp/rpc/solana";
import { assertIsSignature } from "@solana/kit";

/**
 * - `landed`: confirmed with no error. The tokens are in the escrow.
 * - `moved_nothing`: it failed on chain (fees paid, no tokens moved), or it was
 *   never seen and its blockhash has expired, so it never can land.
 * - `pending`: not yet confirmed and still able to land.
 */
export type DvpFundingReceiptState = "landed" | "moved_nothing" | "pending";

/**
 * Classifies one signature status.
 *
 * `processed` is not enough to call either way: a processed transaction can
 * still be dropped with its fork, and a processed failure can be re-executed
 * on the surviving one. Only `confirmed` or better is believed.
 *
 * @param status - The history-searched status, or null when none was found.
 * @param pastExpiry - Whether the cluster is already past the transaction's
 *   last valid block height, read BEFORE the status so nothing can land between.
 * @returns What the transfer did.
 */
export function classifyDvpFundingReceipt(
  status: SignatureStatusInfo | null,
  pastExpiry: boolean
): DvpFundingReceiptState {
  if (status === null) {
    return pastExpiry ? "moved_nothing" : "pending";
  }
  if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") {
    return "pending";
  }
  return status.err === null ? "landed" : "moved_nothing";
}

/**
 * Asks the chain what a receipt's transfer did.
 *
 * Throws on a failed read. A caller that cannot tell must treat the receipt as
 * live, never as gone.
 *
 * @param rpc - The trade's cluster.
 * @param receipt - The row's `funding_tx` and the height it expires at.
 * @returns What the transfer did.
 */
export async function readDvpFundingReceipt(
  rpc: SolanaRpc,
  receipt: { fundingTx: string; expiryHeight: string }
): Promise<DvpFundingReceiptState> {
  assertIsSignature(receipt.fundingTx);
  // Height first: once the cluster is past the expiry height the transfer can
  // no longer land, so a null status read after it is final.
  const blockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
  const statuses = await getSignatureStatuses(rpc, [receipt.fundingTx], {
    searchTransactionHistory: true,
  });
  // One signature asked, one answer owed. A short reply is not "never landed".
  if (statuses.length !== 1) {
    throw new Error(`getSignatureStatuses returned ${statuses.length} statuses for 1 signature`);
  }
  return classifyDvpFundingReceipt(statuses[0], blockHeight > BigInt(receipt.expiryHeight));
}
