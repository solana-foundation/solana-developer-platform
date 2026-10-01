import type { DashboardData, YieldMovement } from "@/types";

/** Fast enough to surface normal Solana confirmation without request fan-out. */
export const ACTIVE_MOVEMENT_REFRESH_MS = 1_000;
export const SETTLEMENT_POLL_TIMEOUT_MS = 2 * 60_000;

export interface MovementPolling {
  movementIds: string[];
  expiresAtByMovement: Record<string, number>;
}

/** Customer-visible completion: Solana confirmation is enough to show Done. */
export function isSettledMovement(movement: YieldMovement): boolean {
  return (
    movement.status === "finalized" ||
    (movement.status === "confirmed" && movement.settlement === "atomic")
  );
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
 * A movement returned by a successful submit request may not be present in the
 * next dashboard read yet. Keep that response in this tab so activity appears
 * immediately and a withdrawal can show its requested token amount until SDP
 * reports the exact settled payout.
 */
export interface SubmittedTransfer {
  movement: YieldMovement;
  requestedTokenAmount: string;
}

export function applySubmittedTransfers(
  live: DashboardData,
  submitted: readonly SubmittedTransfer[]
): DashboardData {
  if (!submitted.length) return live;

  const submittedById = new Map(
    submitted.map((transfer) => [transfer.movement.movementId, transfer])
  );
  const liveIds = new Set(
    live.movements.map((movement) => movement.movementId)
  );
  const optimisticOnly = submitted
    .filter((transfer) => !liveIds.has(transfer.movement.movementId))
    .map(({ movement, requestedTokenAmount }) =>
      withRequestedTokenAmount(movement, requestedTokenAmount)
    );
  const reconciledLive = live.movements.map((movement) =>
    withRequestedTokenAmount(
      movement,
      submittedById.get(movement.movementId)?.requestedTokenAmount
    )
  );

  return {
    ...live,
    movements: [...optimisticOnly, ...reconciledLive].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    ),
  };
}

/** Drop the local overlay once the live ledger has an authoritative outcome. */
export function reconcileSubmittedTransfers(
  submitted: SubmittedTransfer[],
  live: readonly YieldMovement[]
): SubmittedTransfer[] {
  const reconciledIds = new Set(
    live
      .filter(
        (movement) =>
          movement.tokenAmount !== null || movement.status === "failed"
      )
      .map((movement) => movement.movementId)
  );
  const remaining = submitted.filter(
    (transfer) =>
      transfer.movement.status !== "failed" &&
      !reconciledIds.has(transfer.movement.movementId)
  );
  return remaining.length === submitted.length ? submitted : remaining;
}

function withRequestedTokenAmount(
  movement: YieldMovement,
  requestedTokenAmount: string | undefined
): YieldMovement {
  if (
    requestedTokenAmount === undefined ||
    movement.tokenAmount !== null ||
    movement.status === "failed"
  ) {
    return movement;
  }
  return { ...movement, requestedTokenAmount };
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
  const byId = new Map(
    movements.map((movement) => [movement.movementId, movement])
  );
  return {
    settled: inFlight.filter((transfer) => {
      const movement = byId.get(transfer.movementId);
      return movement !== undefined && isSettledMovement(movement);
    }),
    failed: inFlight.filter(
      (transfer) => byId.get(transfer.movementId)?.status === "failed"
    ),
    remaining: inFlight.filter((transfer) => {
      const movement = byId.get(transfer.movementId);
      return movement === undefined || isPendingMovement(movement);
    }),
  };
}
