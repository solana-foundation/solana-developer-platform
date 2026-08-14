import type { FailureCode, OperationState } from "./types";

/**
 * Named guards for advancing an operation. Each guard corresponds to an
 * external condition that must be satisfied before the transition applies:
 * a policy pass, an approval, a proof, a signer response, a submission
 * receipt, or a Photon-indexed confirmation.
 */
export type TransitionGuard =
  | "policy_ok"
  | "approved"
  | "proof_received"
  | "signed"
  | "submitted"
  | "indexed";

export interface FailEdge {
  code: FailureCode;
  retryable: boolean;
}

export interface Transition {
  from: OperationState;
  to: OperationState;
  guard?: TransitionGuard;
  onFail?: FailEdge;
}

/**
 * The single source of truth for legal state transitions. `draft → preparing`
 * has no guard because reserveIntent and the first advance run inside one
 * transaction; no operation is ever observed sitting in `draft`, so no
 * fail edge is defined for it.
 */
export const TRANSITIONS: readonly Transition[] = [
  { from: "draft", to: "preparing" },
  {
    from: "preparing",
    to: "approval_required",
    guard: "policy_ok",
    onFail: { code: "policy_denied", retryable: false },
  },
  {
    from: "approval_required",
    to: "proving",
    guard: "approved",
    onFail: { code: "approval_rejected", retryable: false },
  },
  {
    from: "proving",
    to: "ready_to_sign",
    guard: "proof_received",
    onFail: { code: "proof_failed", retryable: true },
  },
  {
    from: "ready_to_sign",
    to: "submitted",
    guard: "signed",
    onFail: { code: "signer_failed", retryable: true },
  },
  {
    from: "submitted",
    to: "indexing",
    guard: "submitted",
    onFail: { code: "submit_failed", retryable: true },
  },
  {
    from: "indexing",
    to: "completed",
    guard: "indexed",
    onFail: { code: "indexing_timeout", retryable: true },
  },
];

/** Returns the next state for a matching guard, or null if no legal transition exists. */
export function nextState(current: OperationState, guard?: TransitionGuard): OperationState | null {
  const transition = TRANSITIONS.find((t) => t.from === current && t.guard === guard);
  return transition?.to ?? null;
}

/** Returns the fail edge for the given state, or null if none is defined (terminal or draft). */
export function failEdgeFor(current: OperationState): FailEdge | null {
  const transition = TRANSITIONS.find((t) => t.from === current && t.onFail !== undefined);
  return transition?.onFail ?? null;
}
