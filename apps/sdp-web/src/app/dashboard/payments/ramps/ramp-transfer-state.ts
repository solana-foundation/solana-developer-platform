import {
  isCancelableRampTransferStatus,
  isTerminalRampTransferStatus,
  type PaymentTransferStatus,
  type PaymentTransferSummary,
} from "@sdp/types";
import type { CreateTransferOutcome } from "@/app/dashboard/payments/payments-workspace.data";

export function getRampTransferState(status: PaymentTransferStatus) {
  return {
    cancelable: isCancelableRampTransferStatus(status),
    terminal: isTerminalRampTransferStatus(status),
  };
}

/**
 * The approval request a ramp's on-chain send is parked behind, or null.
 *
 * The policy gate answers 202 before the transfer handler runs, so the ramp
 * row never learns about the hold and keeps reading `awaiting_payment`; only
 * this session's send outcome knows. Once the polled row leaves the unfunded
 * statuses (the cancelable ones: the approved send landed, the quote expired,
 * or it was canceled), the row is the truth and the hold no longer shows.
 *
 * @param sendOutcome - What the on-chain send returned, if it has run.
 * @param transfer - The polled ramp transfer, undefined before the first poll.
 * @returns The approval request id while the send is held, otherwise null.
 */
export function heldRampApprovalRequestId(
  sendOutcome: CreateTransferOutcome | null,
  transfer: PaymentTransferSummary | undefined
): string | null {
  if (sendOutcome === null || sendOutcome.kind !== "approval_pending") {
    return null;
  }
  if (transfer !== undefined && !isCancelableRampTransferStatus(transfer.status)) {
    return null;
  }
  return sendOutcome.approvalRequestId;
}
