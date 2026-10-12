import {
  isCancelableRampTransferStatus,
  isTerminalRampTransferStatus,
  type PaymentTransferStatus,
} from "@sdp/types";

export function getRampTransferState(status: PaymentTransferStatus) {
  return {
    cancelable: isCancelableRampTransferStatus(status),
    terminal: isTerminalRampTransferStatus(status),
  };
}
