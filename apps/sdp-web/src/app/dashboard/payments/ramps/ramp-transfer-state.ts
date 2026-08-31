import type { PaymentTransferStatus } from "@sdp/types";

type RampTransferState =
  | { cancelable: true; terminal: false }
  | { cancelable: false; terminal: boolean };

const RAMP_TRANSFER_STATE = {
  pending: { cancelable: true, terminal: false },
  awaiting_payment: { cancelable: true, terminal: false },
  processing: { cancelable: false, terminal: false },
  confirmed: { cancelable: false, terminal: false },
  finalized: { cancelable: false, terminal: false },
  settling: { cancelable: false, terminal: false },
  completed: { cancelable: false, terminal: true },
  failed: { cancelable: false, terminal: true },
  canceled: { cancelable: false, terminal: true },
  expired: { cancelable: false, terminal: true },
} as const satisfies Record<PaymentTransferStatus, RampTransferState>;

export function getRampTransferState(status: PaymentTransferStatus | undefined) {
  if (status === undefined) {
    return { cancelable: false, terminal: false };
  }
  return RAMP_TRANSFER_STATE[status];
}
