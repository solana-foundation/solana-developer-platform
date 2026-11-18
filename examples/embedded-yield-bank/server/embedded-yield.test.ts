import { describe, expect, it, vi } from "vitest";
import type { YieldMovement } from "../src/types";
import {
  assertBuiltFeePayer,
  refreshConfirmingMovements,
} from "./embedded-yield";

describe("Embedded Yield orchestration", () => {
  it("rejects a transaction whose fee payer differs from the request", () => {
    expect(() => assertBuiltFeePayer("northstar", "northstar")).not.toThrow();
    expect(() => assertBuiltFeePayer(undefined, undefined)).not.toThrow();
    expect(() => assertBuiltFeePayer("unexpected", "northstar")).toThrow(
      "unexpected fee payer"
    );
  });

  it("refreshes only movements still waiting for confirmation", async () => {
    const submitted = movement("submitted", "submitted");
    const confirmed = movement("confirmed", "confirmed");
    const getMovement = vi
      .fn()
      .mockResolvedValue({ ...submitted, status: "confirmed" });

    await expect(
      refreshConfirmingMovements(
        { getMovement },
        [submitted, confirmed],
        [submitted.movementId]
      )
    ).resolves.toEqual({
      movements: [{ ...submitted, status: "confirmed" }, confirmed],
      reachedConfirmation: true,
    });
    expect(getMovement).toHaveBeenCalledTimes(1);
    expect(getMovement).toHaveBeenCalledWith(submitted.movementId);
  });

  it("keeps a confirmed provider order under observation without announcing payout", async () => {
    const order = {
      ...movement("confirmed", "order"),
      settlement: "provider_order" as const,
    };
    const getMovement = vi.fn().mockResolvedValue(order);
    const result = await refreshConfirmingMovements(
      { getMovement },
      [order],
      [order.movementId]
    );
    expect(getMovement).toHaveBeenCalledWith(order.movementId);
    expect(result.reachedConfirmation).toBe(false);
  });

  it("keeps the durable status when a confirmation read is unavailable", async () => {
    const submitted = movement("submitted", "submitted");
    const getMovement = vi.fn().mockRejectedValue(new Error("RPC unavailable"));

    await expect(
      refreshConfirmingMovements(
        { getMovement },
        [submitted],
        [submitted.movementId]
      )
    ).resolves.toEqual({
      movements: [submitted],
      reachedConfirmation: false,
    });
  });

  it("does not detail-read historical movements outside the active watch set", async () => {
    const historical = movement("submitted", "historical");
    const active = movement("submitted", "active");
    const getMovement = vi
      .fn()
      .mockResolvedValue({ ...active, status: "confirmed" });

    await expect(
      refreshConfirmingMovements(
        { getMovement },
        [historical, active],
        [active.movementId]
      )
    ).resolves.toEqual({
      movements: [historical, { ...active, status: "confirmed" }],
      reachedConfirmation: true,
    });
    expect(getMovement).toHaveBeenCalledTimes(1);
    expect(getMovement).toHaveBeenCalledWith(active.movementId);
  });
});

function movement(
  status: YieldMovement["status"],
  movementId: string
): YieldMovement {
  return {
    movementId,
    positionId: "position",
    provider: "provider",
    providerReference: "vault",
    direction: "deposit",
    status,
    settlement: "atomic",
    signature: "signature",
    amount: "1",
    denomination: "usdc",
    tokenMint: "usdc",
    tokenAmount: "1",
    failureReason: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    settledAt: null,
  };
}
