import { z } from "zod";
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

/** Signing and provider-broadcast proposals cannot be cancelled once they start broadcasting. */
export const FIREBLOCKS_CANCELLABLE_PROPOSAL_STATUSES = [
  "SUBMITTED",
  "QUEUED",
  "PENDING_AML_SCREENING",
  "PENDING_AUTHORIZATION",
  "PENDING_SIGNATURE",
  "PENDING_3RD_PARTY_MANUAL_APPROVAL",
  "PENDING_3RD_PARTY",
] as const;
const cancellableProposals: ReadonlySet<string> = new Set(FIREBLOCKS_CANCELLABLE_PROPOSAL_STATUSES);
export function isFireblocksProposalCancellable(status: string): boolean {
  return cancellableProposals.has(status);
}

/**
 * The status column of a sign-only proposal: SDP's pre-acceptance state, then the provider
 * transaction statuses it can observe (the cancellable set, the advancing signature states, the
 * documented pending states and the failed set). Pinned by the table's CHECK in
 * `0229_fireblocks_signing_proposals.sql`.
 */
export const FIREBLOCKS_SIGNING_PROPOSAL_STATUSES = [
  "SUBMITTING",
  ...FIREBLOCKS_CANCELLABLE_PROPOSAL_STATUSES,
  "PENDING_STATUS_UPDATE",
  "SIGNED",
  "BROADCASTING",
  "CONFIRMING",
  "COMPLETED",
  ...FIREBLOCKS_FAILED_TRANSACTION_STATUSES,
] as const;
export type FireblocksSigningProposalStatus = (typeof FIREBLOCKS_SIGNING_PROPOSAL_STATUSES)[number];

/** A recovered signature that must never reach a broadcaster the moment it is cancelled. */
export const FIREBLOCKS_SIGNATURE_ACCEPTED_STATUSES = ["SIGNED", "COMPLETED"] as const;
const signatureAccepted: ReadonlySet<string> = new Set(FIREBLOCKS_SIGNATURE_ACCEPTED_STATUSES);
export function isFireblocksSignatureAccepted(status: string): boolean {
  return signatureAccepted.has(status);
}

/** Sign-only proposals stop polling once the signature is accepted or the transaction failed. */
const signingFinished: ReadonlySet<string> = new Set([
  "SIGNED",
  "BROADCASTING",
  "CONFIRMING",
  "COMPLETED",
  ...FIREBLOCKS_FAILED_TRANSACTION_STATUSES,
]);
export function isFireblocksSigningFinished(status: string): boolean {
  return signingFinished.has(status);
}

/** The provider's two spellings of a confirmed cancellation. */
export function isFireblocksCancellationConfirmed(status: string): boolean {
  return status === "CANCELLED" || status === "CANCELED";
}

export const fireblocksProposalSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(["signing", "transfer"]),
  operation: z.string(),
  status: z.string(),
  transactionId: z.string().nullable(),
  createdAt: z.string(),
  cancellationRequestedAt: z.string().nullable(),
  canCancel: z.boolean(),
});
export type FireblocksProposalSummary = z.infer<typeof fireblocksProposalSummarySchema>;
