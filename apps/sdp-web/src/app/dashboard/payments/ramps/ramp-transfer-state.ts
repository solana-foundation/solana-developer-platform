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
