import { describe, expect, it } from "vitest";
import type { YieldMovement } from "@/types";
import {
  reconcileMovementPolling,
  SETTLEMENT_POLL_TIMEOUT_MS,
  startMovementPolling,
} from "./movements";

describe("movement polling", () => {
  it("keeps polling while a submitted movement is absent from a stale read", () => {
    const polling = startMovementPolling(undefined, "movement-1", 0);
    const result = reconcileMovementPolling(
      polling,
      [],
      SETTLEMENT_POLL_TIMEOUT_MS - 1
    );

    expect(result.polling?.movementIds).toEqual(["movement-1"]);
    expect(result.timedOut).toBe(false);
  });

  it("stops polling and reports a movement after the settlement deadline", () => {
    const polling = startMovementPolling(undefined, "movement-1", 0);
    const result = reconcileMovementPolling(
      polling,
      [],
      SETTLEMENT_POLL_TIMEOUT_MS
    );

    expect(result.polling).toBeUndefined();
    expect(result.timedOut).toBe(true);
  });

  it("stops tracking a submitted movement after it becomes terminal", () => {
    const movement = createMovement("finalized");
    const polling = startMovementPolling(undefined, movement.movementId, 0);
    const result = reconcileMovementPolling(polling, [movement], 1);

    expect(result.polling).toBeUndefined();
    expect(result.timedOut).toBe(false);
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
