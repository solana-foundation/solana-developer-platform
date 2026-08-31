import type { PaymentTransferStatus } from "@sdp/types";

interface RampTransferState {
  cancelable: boolean;
  terminal: boolean;
}

const UNKNOWN_RAMP_TRANSFER_STATE: RampTransferState = {
  cancelable: false,
  terminal: false,
};

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

export function getRampTransferState(status: string | undefined): RampTransferState {
  if (!status || !Object.hasOwn(RAMP_TRANSFER_STATE, status)) {
    return UNKNOWN_RAMP_TRANSFER_STATE;
  }
  return RAMP_TRANSFER_STATE[status as PaymentTransferStatus];
}
