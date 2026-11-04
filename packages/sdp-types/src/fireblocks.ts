import { SOL_MINT, type SolanaCluster, wellKnownMint } from "./well-known-tokens";

/** The native TRANSFER path supports only SOL and this cluster's canonical USDC mint. */
export function isFireblocksPaymentMint(mint: string, cluster: SolanaCluster): boolean {
  return mint === SOL_MINT || mint === wellKnownMint("USDC", cluster);
}

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

/**
 * Whether Fireblocks confirmed it refused a transaction because of a policy rule: status
 * `BLOCKED` with the documented sub-status `BLOCKED_BY_POLICY`
 * (https://developers.fireblocks.com/reference/transaction-substatuses). Any other terminal
 * state, including `BLOCKED` without that sub-status, stays the provider's own failure.
 *
 * @param transaction - The Fireblocks transaction's status and sub-status.
 * @returns True only for a confirmed policy refusal.
 */
export function isFireblocksPolicyRefusal(transaction: {
  status: string;
  subStatus?: string | null;
}): boolean {
  return transaction.status === "BLOCKED" && transaction.subStatus === "BLOCKED_BY_POLICY";
}

export const FIREBLOCKS_ADDRESS_STATUSES = [
  "WAITING_FOR_APPROVAL",
  "APPROVED",
  "CANCELLED",
  "REJECTED",
  "FAILED",
] as const;
export type FireblocksAddressStatus = (typeof FIREBLOCKS_ADDRESS_STATUSES)[number];

/** COMPLETED requires verified settlement details; unfamiliar provider states remain pending. */
export function fireblocksPaymentStatus(
  status: string,
  settlementVerified: boolean
): "failed" | "confirmed" | "processing" {
  switch (status) {
    case "COMPLETED":
      return settlementVerified ? "confirmed" : "processing";
    default:
      return isFireblocksTransactionFailed(status) ? "failed" : "processing";
  }
}
