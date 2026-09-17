import type { YieldMovement } from "@/types";

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
