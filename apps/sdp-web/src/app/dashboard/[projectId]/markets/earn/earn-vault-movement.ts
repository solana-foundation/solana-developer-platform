/**
 * The submit-outcome rules shared by the two vault movement modals (deposit
 * and withdrawal).
 *
 * Both modals POST one value-moving request under an idempotency key and
 * resolve the answer into the same shape of outcome: a movement record. The
 * helpers here name that shared contract once, so the two
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
export type VaultMovementOutcomeView<M extends VaultMovementRecord> = {
  kind: "deposit" | "withdrawal";
  movement: M;
};

/**
 * The movement record of a submission that moved (or is moving) money, or
 * undefined before anything is submitted. The same rule decides both what a
 * watcher may observe and whether a balance may be projected.
 */
export function observableVaultMovement<M extends VaultMovementRecord>(
  outcome: VaultMovementOutcomeView<M> | null | undefined
): M | undefined {
  return outcome?.movement;
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
  if (!outcome || !observed) return outcome;
  return { ...outcome, movement: { ...outcome.movement, ...observed } };
}

/**
 * The stepper position for an outcome: before anything is submitted the flow
 * sits on the reviewed step, and a submitted movement reports the step its
 * status maps to.
 */
export function vaultMovementProgressStep<M extends VaultMovementRecord>(
  outcome: VaultMovementOutcomeView<M> | null,
  step: "details" | "review",
  uiState: (status: M["status"]) => { progressStep: number }
): number {
  if (!outcome) return step === "review" ? 1 : 0;
  return uiState(outcome.movement.status).progressStep;
}

/**
 * The stepper labels for one value-moving flow: details, review and
 * processing are common, and a provider-order settlement (whose confirmed
 * status is not yet final) inserts its own step before the complete one.
 * Both vault modals spell the same shape, so the order lives here once.
 */
export function vaultMovementProgressSteps(
  labels: {
    details: string;
    review: string;
    processing: string;
    providerSettlement: string;
    complete: string;
  },
  providerOrder: boolean
): string[] {
  const shared = [labels.details, labels.review, labels.processing];
  return providerOrder
    ? [...shared, labels.providerSettlement, labels.complete]
    : [...shared, labels.complete];
}

/**
 * The focus key for one outcome panel, so a state change that swaps what the
 * customer is looking at also moves focus. `movementKind` is the submitting
 * modal's own word for its movement ("deposit" / "withdrawal").
 */
export function vaultMovementPanelKey(
  outcome: { kind: "deposit" | "withdrawal" } | null,
  step: "details" | "review",
  movementKind: "deposit" | "withdrawal"
): string {
  if (!outcome) return `form:${step}`;
  return `outcome:${movementKind}`;
}

/**
 * Whether the movement is still working: a real movement in one of the given
 * in-flight statuses keeps the modal in its processing presentation.
 */
export function vaultMovementProcessing<M extends VaultMovementRecord>(
  outcome: VaultMovementOutcomeView<M> | null | undefined,
  inFlightStatuses: readonly M["status"][]
): boolean {
  if (!outcome) return false;
  return inFlightStatuses.includes(outcome.movement.status);
}

/** Observe a submission from before its POST until the outcome is recorded. */
export type VaultSubmissionObserver = (custodyWalletId: string) => () => void;
