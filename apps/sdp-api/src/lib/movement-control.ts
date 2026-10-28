import { isMovementId, type MovementId } from "@sdp/types/movements";
import { z } from "zod";

const movementIdSchema = z.custom<MovementId>(
  (value) => typeof value === "string" && isMovementId(value)
);
const disabledMovementsSchema = z.array(movementIdSchema);

/** Reject a malformed operator control instead of silently allowing starts. */
export function parseDisabledMovements(value: unknown): MovementId[] {
  return disabledMovementsSchema.parse(value);
}
