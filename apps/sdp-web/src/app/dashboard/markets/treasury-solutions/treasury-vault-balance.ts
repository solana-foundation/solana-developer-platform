import type { EarnVaultPosition } from "@sdp/types";
import { earnVaultHoldingValue } from "../earn/earn-vault-holding";

export type VaultMovementKind = "deposit" | "withdrawal";

export interface VaultPositionsRead {
  startedAt: number;
  landedAt: number;
  afterMovementIds?: readonly string[];
  positions: readonly Pick<EarnVaultPosition, "id" | "shares" | "tokenValue" | "parIntermediate">[];
}

export interface VaultMovementBalanceState {
  observedOrder: number;
  submittedAt?: number;
  committedObservedAt?: number;
}

export type TrackedVaultMovement = VaultMovementBalanceState & {
  movementId: string;
  positionId: string;
  status: string;
};

export interface VaultActivity<Movement extends TrackedVaultMovement = TrackedVaultMovement> {
  kind: VaultMovementKind;
  movement: Movement;
}

export function isCommittedVaultMovement(movement: Pick<TrackedVaultMovement, "status">): boolean {
  return movement.status === "confirmed" || movement.status === "finalized";
}

export function hasUnconfirmedVaultMovement(
  activities: readonly VaultActivity[],
  positionId?: string
): boolean {
  return activities.some(
    ({ movement }) =>
      (positionId === undefined || movement.positionId === positionId) &&
      ["pending", "requested", "submitted"].includes(movement.status)
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
