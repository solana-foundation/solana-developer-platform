import { describe, expect, it, vi } from "vitest";
import {
  closeEmptyHydratedPositions,
  type HydratedVaultPositionValue,
  hydratedHoldingTokenValue,
} from "./vault-position-hydration";

const WYLDS = "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih";

describe("closeEmptyHydratedPositions", () => {
  it("keeps a position whose shares are gone while its par intermediate remains", async () => {
    const positions = [
      { id: "residual", closedAt: null, updatedAt: "2026-09-29T00:00:00.000Z" },
      { id: "empty", closedAt: null, updatedAt: "2026-09-29T00:00:00.000Z" },
    ];
    const live = new Map<string, HydratedVaultPositionValue>([
      [
        "residual",
        {
          shares: "0",
          withdrawableShares: "0",
          tokenValue: "0",
          parIntermediate: {
            mint: WYLDS,
            amount: "2000",
            withdrawableAmount: "2000",
            tokenValue: "2000",
          },
        },
      ],
      ["empty", { shares: "0", withdrawableShares: "0", tokenValue: "0" }],
    ]);
    const close = vi.fn(async () => true);

    await closeEmptyHydratedPositions(close, positions, live);

    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("empty", "2026-09-29T00:00:00.000Z");
  });

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

describe("hydratedHoldingTokenValue", () => {
  it("adds the par intermediate to the shares' value and never invents one", () => {
    const intermediate = {
      mint: WYLDS,
      amount: "2000",
      withdrawableAmount: "2000",
      tokenValue: "2000",
    };
    expect(
      hydratedHoldingTokenValue({
        shares: "80",
        withdrawableShares: "80",
        tokenValue: "100.5",
        parIntermediate: intermediate,
      })
    ).toBe("2100.5");
    expect(
      hydratedHoldingTokenValue({ shares: "80", withdrawableShares: "80", tokenValue: "100.5" })
    ).toBe("100.5");
    expect(
      hydratedHoldingTokenValue({
        shares: "80",
        withdrawableShares: "80",
        tokenValue: undefined,
        parIntermediate: intermediate,
      })
    ).toBeUndefined();
    expect(hydratedHoldingTokenValue(undefined)).toBeUndefined();
  });
});
