import type { PaymentTransferStatus } from "@sdp/types/payments";

/** The statuses a payout has settled in: what "Paid so far" and "Last paid" count. */
export const SETTLED_PAYOUT_STATUSES: readonly PaymentTransferStatus[] = [
  "completed",
  "confirmed",
  "finalized",
];
