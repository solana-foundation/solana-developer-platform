import {
  decimalScale,
  formatDecimalAmount,
  isDecimalString,
  parseDecimalAmount,
} from "@sdp/solana/amount";
import type { EarnVaultPosition } from "@sdp/types";

/**
 * Optimistic vault balances for the Active positions table.
 *
 * The chain commits a deposit or an atomic withdrawal seconds before the live
 * position read includes it. Between those moments the row shows the latest
 * hydrated read plus the committed movements it cannot contain yet, marked
 * projected.
 *
 * Nothing here compares balances to decide a projection is done: provider
 * valuations legitimately land above or below the arithmetic (Kamino
 * accrues, Veda quotes the redeemable value net of its premium). A movement
 * counts as contained in a read only when that read shows the position's
 * SHARES moved in the movement's own direction off a baseline taken from a
 * read that landed before the POST began, and the change can be attributed
 * to it: the read started after this tab saw the commit, or the movement is
 * the only one that could have moved the shares. A movement with no hydrated
 * pre-POST baseline is not projected at all; timing alone is never evidence.
 *
 * Residual, stated plainly: the row never overstates, because a read that
 * contains a movement necessarily shows its shares moved. It can understate
 * for one read cycle when shares move in the same direction from a source
 * this tab cannot see (another session, a transfer outside SDP) or when two
 * movements on one position overlap; the next read heals it. Attributing a
 * share change to one transaction would need a chain slot on the positions
 * read, which the API does not expose.
 */

export type VaultMovementKind = "deposit" | "withdrawal";

/**
 * Deposits speak the legacy DTO, where `confirmed` is the last word; atomic
 * withdrawals speak the unified ledger, where `finalized` follows it. One set
 * answers "has the chain committed this" for both.
 */
const COMMITTED_VAULT_MOVEMENT_STATUSES: ReadonlySet<string> = new Set(["confirmed", "finalized"]);

/** One landed positions read, with the client clock at both ends. */
export interface VaultPositionsRead {
  startedAt: number;
  landedAt: number;
  positions: readonly Pick<EarnVaultPosition, "id" | "shares" | "tokenValue">[];
}

/** What a read said about one position; an absent row is an exact zero holding. */
export interface VaultHoldingSnapshot {
  /** Undefined when the row came back unhydrated. */
  value: string | undefined;
  shares: string | undefined;
}

/** The hydrated holding a projection measures share movement against. */
export interface VaultProjectionBaseline {
  startedAt: number;
  shares: string;
}

export interface VaultBalanceProjection {
  /** Movement size in the position's deposit token, decimal string. */
  amount: string;
  /** From the last read that landed before the POST began, so it cannot contain the movement. */
  baseline: VaultProjectionBaseline;
}

/** Per-tab state a tracked movement carries on top of its API record. */
export interface VaultMovementProjectionState {
  /** Place in this tab's single activity order; ties resolve oldest first. */
  observedOrder: number;
  balanceProjection?: VaultBalanceProjection;
  /** Client clock when the POST began. A read that landed earlier cannot contain the movement. */
  submittedAt?: number;
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
  /** True while committed movements are bridged over the anchoring read. */
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

export function holdingInRead(read: VaultPositionsRead, positionId: string): VaultHoldingSnapshot {
  const position = read.positions.find((candidate) => candidate.id === positionId);
  if (position === undefined) return { value: "0", shares: "0" };
  return { value: position.tokenValue, shares: position.shares };
}

/**
 * The latest read that landed before the POST began, as a projection baseline.
 * Undefined when no read had landed by then or that read left the position
 * unhydrated: without a baseline nothing can prove a later read contains the
 * movement, so nothing is projected.
 */
export function projectionBaseline(
  reads: readonly VaultPositionsRead[],
  positionId: string,
  submittedAt: number
): VaultProjectionBaseline | undefined {
  for (let index = reads.length - 1; index >= 0; index -= 1) {
    const read = reads[index];
    if (read === undefined || read.landedAt >= submittedAt) continue;
    const { shares } = holdingInRead(read, positionId);
    return shares === undefined ? undefined : { startedAt: read.startedAt, shares };
  }
  return undefined;
}

export function createVaultBalanceProjection(
  amount: string,
  baseline: VaultProjectionBaseline | undefined
): VaultBalanceProjection | undefined {
  return baseline !== undefined && isDecimalString(amount) ? { amount, baseline } : undefined;
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
 * Whether the read shows the shares moved in the movement's own direction off
 * the baseline: up for a deposit, down for a withdrawal. An unhydrated or
 * malformed row proves nothing.
 */
function sharesMovedBy(
  kind: VaultMovementKind,
  baseline: VaultProjectionBaseline,
  holding: VaultHoldingSnapshot
): boolean {
  const live = holding.shares;
  if (live === undefined || !isDecimalString(live) || !isDecimalString(baseline.shares)) {
    return false;
  }
  const scale = Math.max(decimalScale(live), decimalScale(baseline.shares));
  const delta = parseDecimalAmount(live, scale) - parseDecimalAmount(baseline.shares, scale);
  return kind === "deposit" ? delta > 0n : delta < 0n;
}

/**
 * Whether no OTHER movement on the position could have moved its shares
 * between the projection's baseline and this read: every other movement
 * either failed, was submitted after the read landed, or was already
 * committed before the baseline read started.
 */
function isSoleMover(
  movement: ProjectedVaultMovement,
  read: VaultPositionsRead,
  activities: readonly VaultActivity[]
): boolean {
  const baselineStartedAt = movement.balanceProjection?.baseline.startedAt;
  return !activities.some(({ movement: other }) => {
    if (other.movementId === movement.movementId || other.positionId !== movement.positionId) {
      return false;
    }
    if (other.status === "failed") return false;
    if (other.submittedAt !== undefined && read.landedAt < other.submittedAt) return false;
    return !(
      baselineStartedAt !== undefined &&
      other.committedObservedAt !== undefined &&
      baselineStartedAt > other.committedObservedAt
    );
  });
}

/**
 * Whether a read already contains a committed movement. The share witness
 * decides; timing only attributes a change the witness alone cannot.
 */
export function isVaultProjectionReflected(
  { kind, movement }: VaultActivity,
  read: VaultPositionsRead,
  activities: readonly VaultActivity[]
): boolean {
  const projection = movement.balanceProjection;
  if (
    projection === undefined ||
    movement.committedObservedAt === undefined ||
    !isCommittedVaultMovement(movement) ||
    !sharesMovedBy(kind, projection.baseline, holdingInRead(read, movement.positionId))
  ) {
    return false;
  }
  return read.startedAt > movement.committedObservedAt || isSoleMover(movement, read, activities);
}

/**
 * Committed movements whose projection the read does not contain yet, oldest
 * first. Without a read, every committed projection is pending. Optionally
 * narrowed to one position.
 */
export function pendingVaultProjections<Activity extends VaultActivity>(
  activities: readonly Activity[],
  read: VaultPositionsRead | undefined,
  positionId?: string
): Activity[] {
  return activities
    .filter(
      (activity) =>
        (positionId === undefined || activity.movement.positionId === positionId) &&
        activity.movement.balanceProjection !== undefined &&
        isCommittedVaultMovement(activity.movement) &&
        (read === undefined || !isVaultProjectionReflected(activity, read, activities))
    )
    .sort((left, right) => left.movement.observedOrder - right.movement.observedOrder);
}

/** The latest read that valued the position; an absent row values as zero. */
export function anchorRead(
  reads: readonly VaultPositionsRead[],
  positionId: string
): VaultPositionsRead | undefined {
  for (let index = reads.length - 1; index >= 0; index -= 1) {
    const read = reads[index];
    if (read !== undefined && holdingInRead(read, positionId).value !== undefined) return read;
  }
  return undefined;
}

/**
 * The balance a row shows: the anchoring read's value plus every committed
 * movement that read does not contain. Both halves are judged against the
 * SAME read, so a movement is never both inside the value and added again.
 */
export function displayedVaultBalance(
  reads: readonly VaultPositionsRead[],
  positionId: string,
  activities: readonly VaultActivity[]
): DisplayedVaultBalance {
  const anchor = anchorRead(reads, positionId);
  const pending = pendingVaultProjections(activities, anchor, positionId);
  let value = anchor === undefined ? undefined : holdingInRead(anchor, positionId).value;
  for (const { kind, movement } of pending) {
    if (value === undefined || movement.balanceProjection === undefined) {
      return { value: undefined, projected: true };
    }
    value = applyVaultMovement(value, movement.balanceProjection.amount, kind);
  }
  return { value, projected: pending.length > 0 };
}
