import type { SolMovement } from "@/services/payments/sol-rent-minimum";
import type { TransactionChunk } from "./transaction";
import type { ResolvedBatchRequest } from "./types";

/**
 * A native SOL batch as the rent check reads it (HOO-2375): the source wallet,
 * every recipient, and which recipients each chunk carries, since chunks are submitted
 * concurrently in no set order. Null for an SPL batch, whose token-account
 * rent the sponsor pays.
 */
export function solBatchMovement(
  resolved: ResolvedBatchRequest,
  chunks: readonly TransactionChunk[]
): SolMovement | null {
  if (resolved.tokenContext.kind !== "sol") return null;
  return {
    source: resolved.sourceAddress,
    payments: resolved.recipients.map((recipient) => ({
      index: recipient.index,
      destination: recipient.destinationAddress,
      lamports: recipient.amountBaseUnits,
    })),
    transactions: chunks.map((chunk) => chunk.recipientIndexes),
  };
}
