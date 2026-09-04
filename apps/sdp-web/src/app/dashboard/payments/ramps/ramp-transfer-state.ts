import { isTerminalRampTransferStatus, type PaymentTransferStatus } from "@sdp/types";

const RAMP_TRANSFER_CANCELABLE = {
  pending: true,
  awaiting_payment: true,
  processing: false,
  confirmed: false,
  finalized: false,
  settling: false,
  completed: false,
  failed: false,
  canceled: false,
  expired: false,
} as const satisfies Record<PaymentTransferStatus, boolean>;

export function getRampTransferState(status: PaymentTransferStatus | undefined) {
  if (status === undefined) {
    return { cancelable: false, terminal: false };
  }
  return {
    cancelable: RAMP_TRANSFER_CANCELABLE[status],
    terminal: isTerminalRampTransferStatus(status),
  };
}

/** Withdraw funding instructions once a transfer can never settle. `completed` is excluded — the completion screen owns it; `undefined` stays fundable — the quote renders before the first status. */
export function isTerminalTransferStatus(status: PaymentTransferStatus | undefined): boolean {
  return status !== undefined && status !== "completed" && isTerminalRampTransferStatus(status);
}
