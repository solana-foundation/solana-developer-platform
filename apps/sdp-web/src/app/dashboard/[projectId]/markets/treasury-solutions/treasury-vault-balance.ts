import type {
  EarnVaultDirectMovementStatus,
  EarnVaultMovementStatus,
  EarnVaultPosition,
} from "@sdp/types/earn";
import { EARN_LANDED_VAULT_DIRECT_MOVEMENT_STATUSES } from "@sdp/types/earn";
import { earnVaultHoldingValue } from "@/app/dashboard/[projectId]/markets/earn/earn-vault-holding";

type VaultMovementKind = "deposit" | "withdrawal";

/**
 * Every status a tracked vault movement can report, across the two wire
 * vocabularies a watch list sees: the legacy deposit one (`pending`) and the
 * unified vault-direct one (`requested`). Typed, not a bare `string`, so a
 * typo'd status here is a compile error rather than a check that never
 * matches.
 */
export type VaultMovementStatus = EarnVaultMovementStatus | EarnVaultDirectMovementStatus;

export interface VaultPositionsRead {
  startedAt: number;
  landedAt: number;
  afterMovementIds?: readonly string[];
  positions: readonly Pick<EarnVaultPosition, "id" | "shares" | "tokenValue" | "parIntermediate">[];
}

export interface VaultMovementBalanceState {
  observedOrder: number;
  submittedAt?: number;
  /** Retained from the intent even before a newly created position is listed. */
  custodyWalletId?: string;
  committedObservedAt?: number;
}

export type TrackedVaultMovement = VaultMovementBalanceState & {
  movementId: string;
  positionId: string;
  status: VaultMovementStatus;
};

export interface VaultActivity<Movement extends TrackedVaultMovement = TrackedVaultMovement> {
  kind: VaultMovementKind;
  movement: Movement;
}

/**
 * The chain has committed the movement's transaction, so the balance may be
 * re-read. The landed statuses are the shared vocabulary's own list — spelled
 * there once, because "the chain answered" is a fact, not a per-surface guess.
 */
const COMMITTED_VAULT_MOVEMENT_STATUSES: ReadonlySet<VaultMovementStatus> = new Set(
  EARN_LANDED_VAULT_DIRECT_MOVEMENT_STATUSES
);

/**
 * A movement the chain has not (yet) reported on: the balance must not read as
 * settled. `pending` and `requested` are the same fact in the legacy and
 * unified vocabularies; `submitted` is on the wire in both, awaiting the
 * chain's answer.
 */
const UNCONFIRMED_VAULT_MOVEMENT_STATUSES: ReadonlySet<VaultMovementStatus> = new Set([
  "pending",
  "requested",
  "submitted",
]);

export function isCommittedVaultMovement(movement: Pick<TrackedVaultMovement, "status">): boolean {
  return COMMITTED_VAULT_MOVEMENT_STATUSES.has(movement.status);
}

export function hasUnconfirmedVaultMovement(
  activities: readonly VaultActivity[],
  positionId?: string
): boolean {
  return activities.some(
    ({ movement }) =>
      (positionId === undefined || movement.positionId === positionId) &&
      UNCONFIRMED_VAULT_MOVEMENT_STATUSES.has(movement.status)
  );
}

export function observeVaultMovementCommit<Movement extends TrackedVaultMovement>(
  movement: Movement,
  now = Date.now()
): Movement {
  if (movement.committedObservedAt !== undefined || !isCommittedVaultMovement(movement))
    return movement;
  return { ...movement, committedObservedAt: now };
}

export function vaultActivities<
  Deposit extends TrackedVaultMovement,
  Withdrawal extends TrackedVaultMovement,
>(
  deposits: readonly Deposit[],
  withdrawals: readonly Withdrawal[]
): ({ kind: "deposit"; movement: Deposit } | { kind: "withdrawal"; movement: Withdrawal })[] {
  return [
    ...deposits.map((movement) => ({ kind: "deposit" as const, movement })),
    ...withdrawals.map((movement) => ({ kind: "withdrawal" as const, movement })),
  ];
}

/** Read again after confirmation, including recovery and provider-order activity. */
export function pendingVaultBalanceReads<Activity extends VaultActivity>(
  activities: readonly Activity[],
  read: VaultPositionsRead | undefined,
  positionId?: string
): Activity[] {
  const acknowledgedMovements = new Set(read?.afterMovementIds);
  const unreadablePositions = new Set(
    read?.positions
      .filter((position) => earnVaultHoldingValue(position) === undefined)
      .map(({ id }) => id)
  );
  return activities.filter(
    ({ movement }) =>
      (positionId === undefined || movement.positionId === positionId) &&
      isCommittedVaultMovement(movement) &&
      movement.committedObservedAt !== undefined &&
      (!acknowledgedMovements.has(movement.movementId) ||
        unreadablePositions.has(movement.positionId))
  );
}

/**
 * Status can finish at confirmation. Amounts always come from a live provider
 * read whose RPC contexts meet the confirmed movements' slots. Request timing
 * and a changed share count are not freshness proofs. The provider's observed
 * value is displayed without requested-amount arithmetic. Unaffected holdings
 * retain a clearly labelled last verified value through a failed refresh.
 */
export function displayedVaultBalance(
  reads: readonly VaultPositionsRead[],
  positionId: string,
  activities: readonly VaultActivity[],
  readError?: unknown
): { value: string | undefined; syncing: boolean; lastVerifiedAt?: number } {
  if (hasUnconfirmedVaultMovement(activities, positionId))
    return { value: undefined, syncing: true };
  const latest = reads[reads.length - 1];
  const syncing = pendingVaultBalanceReads(activities, latest, positionId).length > 0;
  if (latest === undefined) return { value: undefined, syncing };
  const position = latest.positions.find((candidate) => candidate.id === positionId);
  const value = position ? earnVaultHoldingValue(position) : "0";
  if (value !== undefined && !readError && !syncing) return { value, syncing: false };
  for (let index = reads.length - 1; index >= 0; index -= 1) {
    const read = reads[index];
    const previous = read?.positions.find((candidate) => candidate.id === positionId);
    const previousValue = previous ? earnVaultHoldingValue(previous) : undefined;
    if (
      previousValue !== undefined &&
      pendingVaultBalanceReads(activities, read, positionId).length === 0
    ) {
      return { value: previousValue, syncing: false, lastVerifiedAt: read?.landedAt };
    }
  }
  return { value: undefined, syncing };
}
