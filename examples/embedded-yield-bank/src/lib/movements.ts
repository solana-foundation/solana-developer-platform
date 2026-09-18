import type { DashboardData, YieldMovement } from "@/types";
import { addDecimals, compareDecimals } from "./decimal";

/** Fast enough to surface normal Solana confirmation without request fan-out. */
export const ACTIVE_MOVEMENT_REFRESH_MS = 1_000;
export const SETTLEMENT_POLL_TIMEOUT_MS = 2 * 60_000;

export interface MovementPolling {
  movementIds: string[];
  expiresAtByMovement: Record<string, number>;
}

/** Customer-visible completion: Solana confirmation is enough to show Done. */
export function isSettledMovement(movement: YieldMovement): boolean {
  return movement.status === "confirmed" || movement.status === "finalized";
}

export function isPendingMovement(movement: YieldMovement): boolean {
  return !isSettledMovement(movement) && movement.status !== "failed";
}

/** Internal bookkeeping may keep advancing after the UI already says Settled. */
export function isMovementAwaitingFinality(movement: YieldMovement): boolean {
  return movement.status !== "finalized" && movement.status !== "failed";
}

export function startMovementPolling(
  polling: MovementPolling | undefined,
  movementId: string,
  now = Date.now()
): MovementPolling {
  if (polling?.movementIds.includes(movementId)) return polling;
  return {
    movementIds: [...(polling?.movementIds ?? []), movementId],
    expiresAtByMovement: {
      ...(polling?.expiresAtByMovement ?? {}),
      [movementId]: now + SETTLEMENT_POLL_TIMEOUT_MS,
    },
  };
}

export function reconcileMovementPolling(
  polling: MovementPolling | undefined,
  movements: YieldMovement[],
  now = Date.now()
): {
  polling: MovementPolling | undefined;
  timedOutMovementIds: string[];
} {
  const terminalIds = new Set(
    movements
      .filter((movement) => !isPendingMovement(movement))
      .map((movement) => movement.movementId)
  );
  const next: string[] = [];
  const timedOutMovementIds: string[] = [];
  for (const movementId of polling?.movementIds ?? []) {
    if (terminalIds.has(movementId)) continue;
    const expiresAt = polling?.expiresAtByMovement[movementId] ?? now;
    if (now >= expiresAt) timedOutMovementIds.push(movementId);
    else next.push(movementId);
  }

  return {
    polling: next.length
      ? {
          movementIds: next,
          expiresAtByMovement: Object.fromEntries(
            next.map((movementId) => [
              movementId,
              polling?.expiresAtByMovement[movementId] ?? now,
            ])
          ),
        }
      : undefined,
    timedOutMovementIds,
  };
}

export interface InFlightTransfer {
  movementId: string;
  direction: YieldMovement["direction"];
  amount: string;
  expiresAt: number;
}

/**
 * An internal transfer never changes the total, but its two sides settle on
 * different reads (RPC for checking, SDP for savings) and can disagree for a
 * few seconds. Show the balances a transfer will produce while it is pending
 * and while live snapshots catch up after confirmation, then hand back once
 * both account balances reflect it.
 */
export function applyInFlight(
  base: DashboardData,
  live: DashboardData,
  inFlight: readonly InFlightTransfer[]
): DashboardData {
  if (!inFlight.length) return live;
  const intoSavings = addDecimals(
    inFlight.map((transfer) =>
      transfer.direction === "deposit"
        ? transfer.amount
        : negate(transfer.amount)
    )
  );
  const requested = new Map(
    inFlight.map((transfer) => [transfer.movementId, transfer.amount])
  );
  return {
    ...live,
    checking: {
      balance: floorAtZero(
        addDecimals([base.checking.balance, negate(intoSavings)])
      ),
    },
    savings: {
      ...live.savings,
      balance: shiftBalance(base.savings.balance, intoSavings),
      withdrawable: shiftBalance(base.savings.withdrawable, intoSavings),
    },
    total: base.total,
    movements: live.movements.map((movement) =>
      movement.tokenAmount === null && requested.has(movement.movementId)
        ? {
            ...movement,
            tokenAmount: requested.get(movement.movementId) ?? null,
          }
        : movement
    ),
  };
}

/**
 * Split this tab's in-flight transfers by their customer-visible result. A
 * confirmed transfer is settled in the UI immediately; SDP continues tracking
 * protocol finalization in the background. Failed transfers moved nothing.
 */
export function reconcileInFlight(
  inFlight: readonly InFlightTransfer[],
  movements: readonly YieldMovement[]
): {
  settled: InFlightTransfer[];
  failed: InFlightTransfer[];
  remaining: InFlightTransfer[];
} {
  const status = new Map(
    movements.map((movement) => [movement.movementId, movement.status])
  );
  return {
    settled: inFlight.filter((transfer) => {
      const current = status.get(transfer.movementId);
      return current === "confirmed" || current === "finalized";
    }),
    failed: inFlight.filter(
      (transfer) => status.get(transfer.movementId) === "failed"
    ),
    remaining: inFlight.filter((transfer) => {
      const current = status.get(transfer.movementId);
      return (
        current === undefined ||
        current === "requested" ||
        current === "submitted"
      );
    }),
  };
}

/**
 * When one of several overlapping transfers is reflected, move its effect into
 * the base so the transfers still pending project from the balances that
 * transfer actually produced, not from the snapshot taken before it started.
 */
export function foldSettledTransfers(
  base: DashboardData,
  settled: readonly InFlightTransfer[]
): DashboardData {
  return applyInFlight(base, base, settled);
}

/**
 * Keep confirmed transfers projected until both live account snapshots move
 * in the expected direction. This prevents a lagging provider valuation from
 * briefly restoring the balances shown before confirmation.
 */
export function partitionSettledTransfersBySnapshot(
  base: DashboardData,
  live: DashboardData,
  settled: readonly InFlightTransfer[]
): {
  reflected: InFlightTransfer[];
  waiting: InFlightTransfer[];
} {
  const reflected: InFlightTransfer[] = [];
  const waiting: InFlightTransfer[] = [];
  let nextBase = base;

  // Opposite-direction transfers can cancel each other out. Check their
  // combined effect first so a live snapshot at the net result releases every
  // projection even when no individual transfer target appears on its own.
  if (settled.length && snapshotReflectsTransfers(base, live, settled)) {
    return { reflected: [...settled], waiting };
  }

  for (const transfer of settled) {
    if (snapshotReflectsTransfers(nextBase, live, [transfer])) {
      reflected.push(transfer);
      nextBase = foldSettledTransfers(nextBase, [transfer]);
    } else {
      waiting.push(transfer);
    }
  }

  return { reflected, waiting };
}

function snapshotReflectsTransfers(
  base: DashboardData,
  live: DashboardData,
  transfers: readonly InFlightTransfer[]
): boolean {
  const baseSavings = base.savings.balance;
  const liveSavings = live.savings.balance;
  if (baseSavings === undefined || liveSavings === undefined) return false;

  const projected = foldSettledTransfers(base, transfers);
  const projectedSavings = projected.savings.balance;
  if (projectedSavings === undefined) return false;

  // A settled batch whose transfers cancel out has no projection left to
  // preserve. Release the old base even when yield or unrelated wallet
  // activity has moved the live balances since submission.
  if (
    compareDecimals(projected.checking.balance, base.checking.balance) === 0 &&
    compareDecimals(projectedSavings, baseSavings) === 0
  ) {
    return true;
  }

  return (
    hasReachedProjection(
      base.checking.balance,
      projected.checking.balance,
      live.checking.balance
    ) && hasReachedProjection(baseSavings, projectedSavings, liveSavings)
  );
}

function hasReachedProjection(
  base: string,
  projected: string,
  live: string
): boolean {
  const direction = compareDecimals(projected, base);
  const progress = compareDecimals(live, projected);
  if (direction === 0) return progress === 0;
  return direction > 0 ? progress >= 0 : progress <= 0;
}

function shiftBalance(
  balance: string | undefined,
  shift: string
): string | undefined {
  return balance === undefined
    ? undefined
    : floorAtZero(addDecimals([balance, shift]));
}

function negate(value: string): string {
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

function floorAtZero(value: string): string {
  return value.startsWith("-") ? "0" : value;
}
