import type { DashboardData, YieldMovement } from "@/types";
import { addDecimals } from "./decimal";

/** Fast enough to surface normal Solana confirmation without request fan-out. */
export const ACTIVE_MOVEMENT_REFRESH_MS = 1_000;
export const SETTLEMENT_POLL_TIMEOUT_MS = 2 * 60_000;

export interface MovementPolling {
  movementIds: string[];
  expiresAt: number;
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
    expiresAt: now + SETTLEMENT_POLL_TIMEOUT_MS,
  };
}

export function reconcileMovementPolling(
  polling: MovementPolling | undefined,
  movements: YieldMovement[],
  now = Date.now()
): { polling: MovementPolling | undefined; timedOut: boolean } {
  const terminalIds = new Set(
    movements
      .filter((movement) => !isPendingMovement(movement))
      .map((movement) => movement.movementId)
  );
  const next = polling?.movementIds.filter((id) => !terminalIds.has(id)) ?? [];

  for (const movement of movements.filter(isPendingMovement)) {
    if (!next.includes(movement.movementId)) next.push(movement.movementId);
  }

  if (!next.length) return { polling: undefined, timedOut: false };
  if (polling && now >= polling.expiresAt) {
    return { polling: undefined, timedOut: true };
  }
  return {
    polling: {
      movementIds: next,
      expiresAt: polling?.expiresAt ?? now + SETTLEMENT_POLL_TIMEOUT_MS,
    },
    timedOut: false,
  };
}

export interface InFlightTransfer {
  movementId: string;
  direction: YieldMovement["direction"];
  amount: string;
}

/**
 * An internal transfer never changes the total, but its two sides settle on
 * different reads (RPC for checking, SDP for savings) and can disagree for a
 * few seconds. While a transfer this session submitted is still pending, show
 * the balances it will produce, then hand back to live data once it settles.
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
 * When one of several overlapping transfers finalizes, move its effect into
 * the base so the transfers still pending project from the balances that
 * transfer actually produced, not from the snapshot taken before it started.
 */
export function foldSettledTransfers(
  base: DashboardData,
  settled: readonly InFlightTransfer[]
): DashboardData {
  return applyInFlight(base, base, settled);
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
