import { describe, expect, it } from "vitest";
import type { YieldMovement } from "@/types";
import { reconcilePendingMovementIds, shouldPollMovements } from "./movements";

describe("movement polling", () => {
  it("keeps polling while a submitted movement is absent from a stale read", () => {
    expect(shouldPollMovements(["movement-1"], [])).toBe(true);
    expect(reconcilePendingMovementIds(["movement-1"], [])).toEqual([
      "movement-1",
    ]);
  });

  it("stops tracking a submitted movement after it becomes terminal", () => {
    const movement = createMovement("finalized");

    expect(
      reconcilePendingMovementIds([movement.movementId], [movement])
    ).toEqual([]);
    expect(shouldPollMovements([], [movement])).toBe(false);
  });
});

function createMovement(status: YieldMovement["status"]): YieldMovement {
  return {
    movementId: "movement-1",
    positionId: "position-1",
    provider: "kamino",
    direction: "deposit",
    status,
    signature: "signature",
    amount: "25",
    denomination: "USDC",
    failureReason: null,
    createdAt: "2026-09-17T00:00:00.000Z",
    settledAt: status === "finalized" ? "2026-09-17T00:00:01.000Z" : null,
  };
}
