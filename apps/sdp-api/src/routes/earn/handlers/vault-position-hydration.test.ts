import { describe, expect, it, vi } from "vitest";
import {
  closeEmptyHydratedPositions,
  describeHydrationFailure,
  type HydratedVaultPositionValue,
  hydratedHoldingTokenValue,
} from "./vault-position-hydration";

const WYLDS = "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

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

describe("describeHydrationFailure", () => {
  it("flattens a fan-out failure down to its socket cause, without the endpoint or owner", () => {
    const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const failure = Object.assign(
      new Error("Veda could not read 1 of 1 requested vault positions", {
        cause: new AggregateError(
          [
            new Error(`Veda vault vault_1 read failed for ${OWNER}`, {
              cause: new Error(
                "request to https://rpc.example.invalid/PATH_KEY?api-key=QUERY_KEY failed",
                { cause: new TypeError("fetch failed", { cause: socket }) }
              ),
            }),
          ],
          "Veda vault position reads failed"
        ),
      }),
      { name: "SdpVedaError", code: "VAULT_UNREADABLE" }
    );

    const chain = describeHydrationFailure(failure, OWNER);

    expect(chain).toEqual([
      "SdpVedaError[VAULT_UNREADABLE]: Veda could not read 1 of 1 requested vault positions",
      "AggregateError: Veda vault position reads failed",
      "Error: Veda vault vault_1 read failed for [owner]",
      "Error: request to [url] failed",
      "TypeError: fetch failed",
      "Error[UND_ERR_SOCKET]: other side closed",
    ]);
    expect(JSON.stringify(chain)).not.toMatch(/PATH_KEY|QUERY_KEY/);
  });

  it("drops a bare query string, clips long text, and stops at a cycle", () => {
    const cyclic = new Error("rpc.example.invalid/?api-key=QUERY_KEY refused");
    cyclic.cause = cyclic;
    expect(describeHydrationFailure(cyclic)).toEqual([
      "Error: rpc.example.invalid/[query] refused",
    ]);
    expect(describeHydrationFailure(new Error("x".repeat(1_000)))).toEqual([
      `Error: ${"x".repeat(293)}...`,
    ]);
  });
});
