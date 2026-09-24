import {
  decimalScale,
  formatDecimalAmount,
  isDecimalString,
  parseDecimalAmount,
} from "@sdp/solana/amount";

/**
 * Optimistic vault balances for the Active positions table.
 *
 * The chain commits a deposit or an atomic withdrawal seconds before the live
 * position read includes it. Between those two moments the row shows the last
 * balance it had plus the committed movements, marked as projected. A
 * projection never compares values to decide it is done: provider valuations
 * legitimately land above or below the arithmetic (Kamino accrues, Veda quotes
 * the redeemable value net of its premium), so the only honest signal is a
 * live read that STARTED after this tab saw the movement committed.
 */

export type VaultMovementKind = "deposit" | "withdrawal";

/**
 * Deposits speak the legacy DTO, where `confirmed` is the last word; atomic
 * withdrawals speak the unified ledger, where `finalized` follows it. One set
 * answers "has the chain committed this" for both.
 */
const COMMITTED_VAULT_MOVEMENT_STATUSES: ReadonlySet<string> = new Set(["confirmed", "finalized"]);

export interface VaultBalanceProjection {
  /** Movement size in the position's deposit token, decimal string. */
  amount: string;
  /**
   * The balance on screen when the movement was submitted: a live read taken
   * before the transaction existed, or an earlier projection stacked on one.
   * Either way it cannot already contain this movement.
   */
  baselineValue: string;
}

/** Per-tab state a tracked movement carries on top of its API record. */
export interface VaultMovementProjectionState {
  /** Place in this tab's single activity order; ties resolve oldest first. */
  observedOrder: number;
  balanceProjection?: VaultBalanceProjection;
  /** Client clock when this tab first saw the movement committed on chain. */
  committedObservedAt?: number;
}

export type ProjectedVaultMovement = VaultMovementProjectionState & {
  movementId: string;
  positionId: string;
  status: string;
};

export interface VaultActivity<Movement extends ProjectedVaultMovement = ProjectedVaultMovement> {
  kind: VaultMovementKind;
  movement: Movement;
}

export interface DisplayedVaultBalance {
  value: string | undefined;
  /** True while committed movements are bridged over the last live read. */
  projected: boolean;
}

export function isCommittedVaultMovement(
  movement: Pick<ProjectedVaultMovement, "status">
): boolean {
  return COMMITTED_VAULT_MOVEMENT_STATUSES.has(movement.status);
}

/** Stamp the first sighting of a committed status; later updates keep that instant. */
export function observeVaultMovementCommit<Movement extends ProjectedVaultMovement>(
  movement: Movement,
  now = Date.now()
): Movement {
  if (movement.committedObservedAt !== undefined || !isCommittedVaultMovement(movement)) {
    return movement;
  }
  return { ...movement, committedObservedAt: now };
}

export function createVaultBalanceProjection(
  baselineValue: string | undefined,
  amount: string
): VaultBalanceProjection | undefined {
  if (baselineValue === undefined || !isDecimalString(baselineValue) || !isDecimalString(amount)) {
    return undefined;
  }
  return { amount, baselineValue };
}

/** Deposits add, withdrawals subtract and floor at zero, all in fixed point. */
export function applyVaultMovement(
  balance: string,
  amount: string,
  kind: VaultMovementKind
): string | undefined {
  if (!isDecimalString(balance) || !isDecimalString(amount)) return undefined;
  const scale = Math.max(decimalScale(balance), decimalScale(amount));
  const base = parseDecimalAmount(balance, scale);
  const delta = parseDecimalAmount(amount, scale);
  const next = kind === "deposit" ? base + delta : base - delta;
  return formatDecimalAmount(next > 0n ? next : 0n, scale);
}

/**
 * A live read reflects a movement once it started after this tab saw the
 * commit. A read started earlier may or may not include the transaction, and
 * the balance it carries is never trusted to say which.
 */
export function isVaultProjectionReflected(
  movement: Pick<ProjectedVaultMovement, "committedObservedAt">,
  liveReadStartedAt: number | undefined
): boolean {
  return (
    liveReadStartedAt !== undefined &&
    movement.committedObservedAt !== undefined &&
    liveReadStartedAt > movement.committedObservedAt
  );
}

export function vaultActivities<
  Deposit extends ProjectedVaultMovement,
  Withdrawal extends ProjectedVaultMovement,
>(
  deposits: readonly Deposit[],
  withdrawals: readonly Withdrawal[]
): ({ kind: "deposit"; movement: Deposit } | { kind: "withdrawal"; movement: Withdrawal })[] {
  return [
    ...deposits.map((movement) => ({ kind: "deposit" as const, movement })),
    ...withdrawals.map((movement) => ({ kind: "withdrawal" as const, movement })),
  ];
}

/**
 * Committed movements whose projection no live read has caught up with,
 * oldest first. Optionally narrowed to one position.
 */
export function pendingVaultProjections<Activity extends VaultActivity>(
  activities: readonly Activity[],
  liveReadStartedAt: number | undefined,
  positionId?: string
): Activity[] {
  return activities
    .filter(
      ({ movement }) =>
        (positionId === undefined || movement.positionId === positionId) &&
        movement.balanceProjection !== undefined &&
        isCommittedVaultMovement(movement) &&
        !isVaultProjectionReflected(movement, liveReadStartedAt)
    )
    .sort((left, right) => left.movement.observedOrder - right.movement.observedOrder);
}

/**
 * The balance a row shows. With nothing pending it is the live value. With
 * pending projections it is the OLDEST projection's baseline plus every
 * pending movement. That baseline predates all of their transactions, so
 * nothing can be counted twice; the live value, which may already contain
 * some of them, is deliberately not the anchor.
 */
export function displayedVaultBalance(
  liveValue: string | undefined,
  pending: readonly VaultActivity[]
): DisplayedVaultBalance {
  const [oldest] = pending;
  if (oldest === undefined) return { value: liveValue, projected: false };
  let value: string | undefined = oldest.movement.balanceProjection?.baselineValue;
  for (const { kind, movement } of pending) {
    if (value === undefined || movement.balanceProjection === undefined) {
      return { value: undefined, projected: true };
    }
    value = applyVaultMovement(value, movement.balanceProjection.amount, kind);
  }
  return { value, projected: true };
}
