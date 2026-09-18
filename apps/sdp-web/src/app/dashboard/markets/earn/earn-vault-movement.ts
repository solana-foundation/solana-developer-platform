/**
 * The submit-outcome rules shared by the two vault movement modals (deposit
 * and withdrawal).
 *
 * Both modals POST one value-moving request under a held idempotency key and
 * resolve the answer into the same shape of outcome: either the approval
 * executor still holds the request (`approval_pending`), or a movement record
 * came back — possibly one the approval's own execution absorbed while the
 * key was held. The helpers here name that shared contract once, so the two
 * modals cannot drift apart on when a submission counts as "money moved",
 * what a watcher may observe, and which panel each state belongs to.
 */

/** The movement-record fields the shared outcome rules read. */
export interface VaultMovementRecord {
  movementId: string;
  status: string;
  failureReason?: string | null;
  replayed?: boolean;
}

/**
 * One submitted movement's outcome as the shared rules see it. The deposit
 * modal's movement branch carries extra presentation fields (the amount and
 * wallet name it announced) that the rules never read.
 */
export type VaultMovementOutcomeView<M extends VaultMovementRecord> =
  | { kind: "approval_pending"; approvalRequestId?: string; walletOperationId?: string }
  | { kind: "deposit" | "withdrawal"; movement: M; absorbedByApproval?: true };

/**
 * The movement record of a submission that actually moved (or is moving)
 * money, or undefined while the approval executor still holds the request or
 * when this submission was absorbed as the approval's replay. The same rule
 * decides both what a watcher may observe and whether a balance may be
 * projected: an absorbed submission moved nothing, so there is nothing to
 * watch and nothing to anticipate.
 */
export function observableVaultMovement<M extends VaultMovementRecord>(
  outcome: VaultMovementOutcomeView<M> | null | undefined
): M | undefined {
  if (!outcome || outcome.kind === "approval_pending" || outcome.absorbedByApproval) {
    return undefined;
  }
  return outcome.movement;
}

/** The `observableVaultMovement` rule as a predicate, for gates that only ask whether to project. */
export function vaultMovementHappened<M extends VaultMovementRecord>(
  outcome: VaultMovementOutcomeView<M> | null | undefined
): boolean {
  return observableVaultMovement(outcome) !== undefined;
}

/**
 * Fold one freshly observed movement record into a still-open outcome, so the
 * watcher's newer status wins over the submission's snapshot. Everything
 * outside the movement record is left exactly as submitted. The movement type
 * is the outcome's own (`NoInfer`): a watcher's read-back record may carry
 * fields the submission's snapshot lacks, and they merge in as extra data.
 */
export function mergeObservedVaultMovement<
  M extends VaultMovementRecord,
  T extends VaultMovementOutcomeView<M>,
>(outcome: T | null, observed: NoInfer<Partial<M>> | undefined): T | null {
  if (!outcome || outcome.kind === "approval_pending" || !observed) return outcome;
  // The kind check ruled out the approval branch, so this outcome carries a
  // movement record; the cast only re-attaches that fact for the compiler.
  const moved = outcome as T & { movement: M };
  return { ...moved, movement: { ...moved.movement, ...observed } } as T;
}

/**
 * The stepper position for an outcome: before anything is submitted the flow
 * sits on the reviewed step, an approval-pending or absorbed submission parks
 * on "processing" (its movement did not and will not report a status of its
 * own), and a real movement reports the step its status maps to.
 */
export function vaultMovementProgressStep<M extends VaultMovementRecord>(
  outcome: VaultMovementOutcomeView<M> | null,
  step: "details" | "review",
  uiState: (status: M["status"]) => { progressStep: number }
): number {
  if (!outcome) return step === "review" ? 1 : 0;
  if (outcome.kind === "approval_pending" || outcome.absorbedByApproval) return 2;
  return uiState(outcome.movement.status).progressStep;
}

/**
 * The focus key for one outcome panel, so a state change that swaps what the
 * customer is looking at also moves focus. `movementKind` is the submitting
 * modal's own word for its movement ("deposit" / "withdrawal").
 */
export function vaultMovementPanelKey(
  outcome:
    | { kind: "approval_pending" }
    | { kind: "deposit" | "withdrawal"; absorbedByApproval?: true }
    | null,
  step: "details" | "review",
  movementKind: "deposit" | "withdrawal"
): string {
  if (!outcome) return `form:${step}`;
  if (outcome.kind === "approval_pending") return "outcome:approval";
  return outcome.absorbedByApproval
    ? `outcome:${movementKind}:absorbed`
    : `outcome:${movementKind}`;
}

/**
 * Whether the movement is still working: a real movement in one of the given
 * in-flight statuses keeps the modal in its processing presentation.
 */
export function vaultMovementProcessing<M extends VaultMovementRecord>(
  outcome: VaultMovementOutcomeView<M> | null | undefined,
  inFlightStatuses: readonly M["status"][]
): boolean {
  if (!outcome || outcome.kind === "approval_pending" || outcome.absorbedByApproval) return false;
  return inFlightStatuses.includes(outcome.movement.status);
}

/**
 * The approval-pending outcome both value-moving endpoints answer with (the
 * 202 contract): the request is held for an approval executor, which may or
 * may not have pinned ids onto it yet.
 */
export function vaultApprovalPending(handled: {
  approvalRequestId?: string;
  walletOperationId?: string;
}): { kind: "approval_pending"; approvalRequestId?: string; walletOperationId?: string } {
  return {
    kind: "approval_pending",
    ...(handled.approvalRequestId ? { approvalRequestId: handled.approvalRequestId } : {}),
    ...(handled.walletOperationId ? { walletOperationId: handled.walletOperationId } : {}),
  };
}
