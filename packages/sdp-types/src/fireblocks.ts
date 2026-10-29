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
