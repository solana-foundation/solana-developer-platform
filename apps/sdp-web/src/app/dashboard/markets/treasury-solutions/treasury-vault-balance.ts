import type { EarnVaultPosition } from "@sdp/types";
import { earnVaultHoldingValue } from "../earn/earn-vault-holding";

export type VaultMovementKind = "deposit" | "withdrawal";

export interface VaultPositionsRead {
  startedAt: number;
  landedAt: number;
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
  return activities.filter(
    ({ movement }) =>
      (positionId === undefined || movement.positionId === positionId) &&
      isCommittedVaultMovement(movement) &&
      movement.committedObservedAt !== undefined &&
      (read === undefined || read.startedAt <= movement.committedObservedAt)
  );
}

/**
 * Status can finish at confirmation. Amounts always come from a live provider
 * read requested afterwards, never requested-amount arithmetic or a fallback
 * to an older valuation. This is an observed balance, not a same-slot portfolio
 * snapshot: provider/RPC freshness remains an external dependency.
 */
export function displayedVaultBalance(
  reads: readonly VaultPositionsRead[],
  positionId: string,
  activities: readonly VaultActivity[]
): { value: string | undefined; syncing: boolean } {
  const latest = reads[reads.length - 1];
  const syncing = pendingVaultBalanceReads(activities, latest, positionId).length > 0;
  if (syncing || latest === undefined) return { value: undefined, syncing };
  const position = latest.positions.find((candidate) => candidate.id === positionId);
  return { value: position ? earnVaultHoldingValue(position) : "0", syncing: false };
}
