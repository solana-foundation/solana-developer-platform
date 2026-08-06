import type { EarnPortfolioPosition, EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { withdrawLanes } from "./earn-program-presentation";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function strategy(partial: Partial<EarnStrategy> & { providerReference: string }): EarnStrategy {
  return {
    id: `earn_${partial.providerReference}`,
    provider: "ground",
    name: partial.providerReference,
    sourceKind: "defi",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: "0.05",
    liquidityTerm: "instant",
    riskMetadata: {},
    status: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...partial,
  };
}

function position(partial: Partial<EarnPortfolioPosition>): EarnPortfolioPosition {
  return { kind: "cash", label: "Cash", valueUsd: "0", pct: 0, ...partial };
}

describe("withdrawLanes", () => {
  it("attributes token-bearing slices by their wire token", () => {
    const lanes = withdrawLanes(
      [
        position({ kind: "cash", valueUsd: "5.000000", token: "usdt" }),
        position({ kind: "cash", valueUsd: "2.500000", token: "usdc" }),
      ],
      []
    );
    expect(lanes.totals.get("usdt")).toBe(5);
    expect(lanes.totals.get("usdc")).toBe(2.5);
    expect(lanes.unattributedUsd).toBe(0);
  });

  it("resolves deployed slices through the catalogue by yield-source reference", () => {
    // Ground's deployed slices don't reliably carry a token on the wire — the
    // lane comes from the yield source's deposit mint, the holdings join.
    const lanes = withdrawLanes(
      [position({ kind: "yield_source", valueUsd: "100", yieldSourceId: "kamino-usdc" })],
      [strategy({ providerReference: "kamino-usdc" })]
    );
    expect(lanes.totals.get("usdc")).toBe(100);
    expect(lanes.unattributedUsd).toBe(0);
  });

  it("sums cash and deployed slices into one lane", () => {
    const lanes = withdrawLanes(
      [
        position({ kind: "yield_source", valueUsd: "100", yieldSourceId: "kamino-usdc" }),
        position({ kind: "cash", valueUsd: "5", token: "usdc" }),
      ],
      [strategy({ providerReference: "kamino-usdc" })]
    );
    expect(lanes.totals.get("usdc")).toBe(105);
  });

  it("banks unresolvable value as unattributed instead of dropping or guessing", () => {
    // No token, no catalogue row (e.g. the catalogue read is still in flight):
    // callers widen every lane's ceiling by this, so an incomplete join can
    // only over-allow (the preview catches that) — never under-cap a valid Max.
    const lanes = withdrawLanes(
      [position({ kind: "yield_source", valueUsd: "100", yieldSourceId: "kamino-usdc" })],
      []
    );
    expect(lanes.totals.size).toBe(0);
    expect(lanes.unattributedUsd).toBe(100);
  });

  it("ignores non-positive and malformed values", () => {
    const lanes = withdrawLanes(
      [
        position({ kind: "cash", valueUsd: "0", token: "usdc" }),
        position({ kind: "cash", valueUsd: "-3", token: "usdc" }),
        position({ kind: "cash", valueUsd: "not-a-number", token: "usdc" }),
      ],
      []
    );
    expect(lanes.totals.size).toBe(0);
    expect(lanes.unattributedUsd).toBe(0);
  });
});
