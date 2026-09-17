import type { DashboardData, YieldMovement } from "@/types";
import { addDecimals } from "./decimal";

export const SETTLEMENT_POLL_TIMEOUT_MS = 2 * 60_000;

export interface MovementPolling {
  movementIds: string[];
  expiresAt: number;
}

export function isPendingMovement(movement: YieldMovement): boolean {
  return !["finalized", "failed"].includes(movement.status);
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
