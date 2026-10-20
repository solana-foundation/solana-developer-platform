/** Provider states shared by parsing, persistence and presentation. */
export const FIREBLOCKS_FAILED_TRANSACTION_STATUSES = [
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "CANCELED",
  "BLOCKED",
] as const;
const failedTransactions: ReadonlySet<string> = new Set(FIREBLOCKS_FAILED_TRANSACTION_STATUSES);
export function isFireblocksTransactionFailed(status: string): boolean {
  return failedTransactions.has(status);
}
export const FIREBLOCKS_ADDRESS_STATUSES = [
  "WAITING_FOR_APPROVAL",
  "APPROVED",
  "CANCELLED",
  "REJECTED",
  "FAILED",
] as const;
export type FireblocksAddressStatus = (typeof FIREBLOCKS_ADDRESS_STATUSES)[number];

/** Native transfers complete only at COMPLETED; unfamiliar provider states remain pending. */
export function fireblocksPaymentStatus(status: string): "failed" | "confirmed" | "processing" {
  switch (status) {
    case "COMPLETED":
      return "confirmed";
    default:
      return isFireblocksTransactionFailed(status) ? "failed" : "processing";
  }
}
