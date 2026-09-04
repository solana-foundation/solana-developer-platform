import {
  isCancelableRampTransferStatus,
  isTerminalRampTransferStatus,
  type PaymentTransferStatus,
} from "@sdp/types";

export function getRampTransferState(status: PaymentTransferStatus | undefined) {
  if (status === undefined) {
    return { cancelable: false, terminal: false };
  }
  return {
    cancelable: isCancelableRampTransferStatus(status),
    terminal: isTerminalRampTransferStatus(status),
  };
}

/** Withdraw funding instructions once a transfer can never settle. `completed` is excluded — the completion screen owns it; `undefined` stays fundable — the quote renders before the first status. */
export function isTerminalTransferStatus(status: PaymentTransferStatus | undefined): boolean {
  return status !== undefined && status !== "completed" && isTerminalRampTransferStatus(status);
}
