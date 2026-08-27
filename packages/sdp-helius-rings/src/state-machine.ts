import type { FailureCode, OperationState } from "./types";

/**
 * Every way an operation's state can change, and who performs it.
 *
 *   draft → preparing → approval_required → proving → ready_to_sign
 *                                                          ↓
 *                              completed ← indexing ← submitted
 *
 *   any of preparing…indexing → failed
 *   failed → completed
 *   failed → voided
 *
 * Three mechanisms, deliberately not one:
 *
 *  - **The guarded path**, the arrows across the top. `TRANSITIONS` below, driven
 *    by `nextState`. Every edge here is something a caller can cause by naming
 *    a guard, which is why the table holds only moves that are safe to trigger
 *    that way.
 *  - **Failing**, from any non-terminal state. Performed by the repository's
 *    `failOperation`, not by `nextState`. The `onFail` metadata on the
 *    transitions below supplies each state's default code and retryability; the
 *    move itself is never a row, because it is available from everywhere.
 *  - **Reconciling a signed failure**, `failed → completed` and
 *    `failed → voided`. Owned by the reconcile route in `@sdp/api`
 *    (`completeFromFailed`, `voidOperation`). Kept out of `TRANSITIONS` on
 *    purpose: neither is a condition an operation satisfies on its own — each
 *    needs the chain observed about a transaction already signed and broadcast —
 *    and as a row, either would let any worker driving `nextState` complete a
 *    signed failure without asking Photon first.
 *
 * `completed` and `voided` are absolutely terminal. `failed` is terminal to the
 * pipeline and reachable-from only by reconciliation.
 */

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
 * The guarded path, and only that — see the module comment for the other two
 * mechanisms and why they are not rows here.
 *
 * `draft → preparing` has no guard because reserveIntent and the first advance
 * run inside one transaction; no operation is ever observed sitting in `draft`,
 * so no fail edge is defined for it.
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
