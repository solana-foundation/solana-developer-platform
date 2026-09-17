import type { YieldMovement } from "@/types";

export function isPendingMovement(movement: YieldMovement): boolean {
  return !["finalized", "failed"].includes(movement.status);
}

export function reconcilePendingMovementIds(
  pendingIds: string[],
  movements: YieldMovement[]
): string[] {
  return pendingIds.filter((id) => {
    const movement = movements.find((item) => item.movementId === id);
    return !movement || isPendingMovement(movement);
  });
}

export function shouldPollMovements(
  pendingIds: string[],
  movements: YieldMovement[]
): boolean {
  return pendingIds.length > 0 || movements.some(isPendingMovement);
}
