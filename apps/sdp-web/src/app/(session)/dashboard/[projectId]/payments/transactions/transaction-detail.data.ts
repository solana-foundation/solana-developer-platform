import type { UnifiedTransaction } from "@sdp/types/unified-transactions";
import type { z } from "zod";
import type { transferDetailSchema } from "@/app/(session)/dashboard/[projectId]/payments/payments-read-schemas";

/** The transfer record as the API returns it, with the network fee the shared type leaves out. */
export type PaymentTransferDetail = z.infer<typeof transferDetailSchema>;

/**
 * The ledger row with what its transfer says now: a provider read can advance a payment after
 * the ledger last recorded it.
 */
export function withTransferState(
  transaction: UnifiedTransaction,
  transfer: PaymentTransferDetail | null
): UnifiedTransaction {
  if (transaction.module !== "payments" || transfer === null) return transaction;
  if (transfer.fireblocks) {
    return {
      ...transaction,
      moduleStatus: transfer.status,
      signature: transfer.signature,
      status:
        transfer.status === "failed"
          ? "failed"
          : ["confirmed", "finalized"].includes(transfer.status)
            ? "succeeded"
            : "pending",
    };
  }
  // A live ramp's state replaces the ledger's snapshot of it.
  if (transfer.type === "onramp" || transfer.type === "offramp") {
    return { ...transaction, moduleStatus: transfer.status, signature: transfer.signature };
  }
  return transaction;
}
