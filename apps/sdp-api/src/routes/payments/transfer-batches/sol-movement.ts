import type { SolMovement } from "@/services/payments/sol-rent-minimum";
import type { TransactionChunk } from "./transaction";
import type { ResolvedBatchRequest } from "./types";

/**
 * A native SOL batch as the rent check reads it (HOO-2375): the source wallet,
 * every recipient, and what each chunk moves, since chunks are submitted
 * concurrently in no set order. Null for an SPL batch, whose token-account
 * rent the sponsor pays.
 */
export function solBatchMovement(
  resolved: ResolvedBatchRequest,
  chunks: readonly TransactionChunk[]
): SolMovement | null {
  if (resolved.tokenContext.kind !== "sol") return null;
  const lamportsByIndex = new Map(
    resolved.recipients.map((recipient) => [recipient.index, recipient.amountBaseUnits])
  );
  return {
    source: resolved.sourceAddress,
    payments: resolved.recipients.map((recipient) => ({
      index: recipient.index,
      destination: recipient.destinationAddress,
      lamports: recipient.amountBaseUnits,
    })),
    transactionLamports: chunks.map((chunk) =>
      chunk.recipientIndexes.reduce((sum, index) => sum + (lamportsByIndex.get(index) ?? 0n), 0n)
    ),
  };
}
