import type { PolicyDecision, WalletOperationStatus } from "@sdp/types";

/** Strictness ordering used to combine rule and scope decisions: highest rank wins. */
export const DECISION_RANK = {
  not_evaluated: 0,
  allow: 1,
  review: 2,
  provider_approval_required: 3,
  approval_required: 4,
  deny: 5,
} as const satisfies Record<PolicyDecision, number>;

/**
 * Whether a decision pauses the operation for an approval.
 *
 * @param decision - The decision to classify.
 * @returns True for the approval-flavored decisions.
 */
export function isApprovalDecision(decision: PolicyDecision): boolean {
  return decision === "approval_required" || decision === "provider_approval_required";
}

/**
 * The wallet-operation status a fresh policy decision transitions the operation to.
 *
 * @param decision - The evaluated decision.
 * @returns The resulting operation status.
 */
export function walletOperationStatusForDecision(decision: PolicyDecision): WalletOperationStatus {
  switch (decision) {
    case "allow":
      return "evaluated";
    case "approval_required":
    case "provider_approval_required":
    case "review":
      return "pending_approval";
    case "deny":
    case "not_evaluated":
      return "failed";
    default: {
      const exhaustive: never = decision;
      throw new Error(`Unhandled policy decision: ${String(exhaustive)}`);
    }
  }
}
