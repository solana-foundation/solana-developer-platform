import {
  isSuccessfulPaymentTransferStatus,
  type PaymentTransferSummary,
} from "@sdp/types/payments";

/**
 * What became of a sent transfer, for its heading and its message. A signature alone is not
 * success: a transfer is sent once its status says it settled, and failed whatever it carries.
 */
export type SendResultKind =
  | "failed"
  | "sent"
  | "fireblocksPending"
  | "fireblocksUnknown"
  | "pending";

export function sendResultKind(transfer: PaymentTransferSummary): SendResultKind {
  if (transfer.status === "failed") return "failed";
  if (isSuccessfulPaymentTransferStatus(transfer.status)) return "sent";
  if (transfer.fireblocks && transfer.signature === null) {
    return transfer.fireblocks.transactionId ? "fireblocksPending" : "fireblocksUnknown";
  }
  return "pending";
}
