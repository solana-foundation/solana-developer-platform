import { describe, expect, it, vi } from "vitest";
import {
  closeEmptyHydratedPositions,
  type HydratedVaultPositionValue,
} from "./vault-position-hydration";

describe("closeEmptyHydratedPositions", () => {
  it("bounds close-out writes while still attempting every empty position", async () => {
    const positions = Array.from({ length: 20 }, (_, index) => ({
      id: `position_${index}`,
      closedAt: null,
      updatedAt: `2026-09-22T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    const live = new Map<string, HydratedVaultPositionValue>(
      positions.map((position) => [
        position.id,
        { shares: "0", withdrawableShares: "0", tokenValue: "0" },
      ])
    );
    let active = 0;
    let maximum = 0;
    const close = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return true;
    });

    await closeEmptyHydratedPositions(close, positions, live);

    expect(close).toHaveBeenCalledTimes(20);
    expect(maximum).toBe(8);
  });
});
