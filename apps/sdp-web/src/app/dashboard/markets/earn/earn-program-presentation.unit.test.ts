import type { EarnPortfolioPosition, EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  portfolioTotals,
  programTitle,
  strategiesByReference,
  withdrawLanes,
} from "./earn-program-presentation";

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

describe("programTitle", () => {
  const catalogue = strategiesByReference("ground", [
    strategy({ providerReference: "kamino-usdc", name: "Kamino USDC" }),
    strategy({ providerReference: "jaaa-usdc", name: "Ground JAAA USDC" }),
  ]);

  it("names a program after the vault it targets", () => {
    const title = programTitle(
      { usdc: [{ yieldSourceId: "kamino-usdc", weightBps: 10_000 }] },
      null,
      catalogue,
      "fallback"
    );
    expect(title).toBe("Kamino USDC");
  });

  it("joins distinct vaults across token lanes", () => {
    const title = programTitle(
      {
        usdc: [{ yieldSourceId: "kamino-usdc", weightBps: 10_000 }],
        usdt: [{ yieldSourceId: "jaaa-usdc", weightBps: 10_000 }],
      },
      null,
      catalogue,
      "fallback"
    );
    expect(title).toBe("Kamino USDC · Ground JAAA USDC");
  });

  it("ignores cash lanes and zero-weight entries", () => {
    const title = programTitle(
      {
        usdc: [{ yieldSourceId: "cash", weightBps: 10_000 }],
        usdt: [{ yieldSourceId: "kamino-usdc", weightBps: 0 }],
      },
      "Treasury",
      catalogue,
      "fallback"
    );
    expect(title).toBe("Treasury");
  });

  it("falls back to the label, then to the supplied fallback", () => {
    expect(programTitle({}, "Treasury", catalogue, "fallback")).toBe("Treasury");
    expect(programTitle({}, null, catalogue, "fallback")).toBe("fallback");
  });

  // The catalogue read can still be in flight while the program renders.
  it("falls back rather than rendering a raw provider reference", () => {
    const title = programTitle(
      { usdc: [{ yieldSourceId: "kamino-usdc", weightBps: 10_000 }] },
      null,
      new Map(),
      "fallback"
    );
    expect(title).toBe("fallback");
  });
});

describe("strategiesByReference", () => {
  // Provider references are only unique WITHIN a provider, so the filter is
  // part of the contract — an unfiltered map could name another provider's
  // vault on this program's card.
  it("excludes other providers' strategies from the map", () => {
    const map = strategiesByReference("ground", [
      strategy({ providerReference: "shared-ref", name: "Ground vault" }),
      strategy({ providerReference: "shared-ref", name: "Veda vault", provider: "veda" }),
    ]);
    expect(map.get("shared-ref")?.name).toBe("Ground vault");
    expect(map.size).toBe(1);
  });
});

describe("portfolioTotals", () => {
  const program = (totalUsd: string, earnedUsd: string, apy?: string) => ({
    wallet: { balance: { totalUsd, earnedUsd, withdrawableUsd: totalUsd } },
    ...(apy ? { yield: { currentApy: apy } } : {}),
  });

  it("sums money across programs", () => {
    const totals = portfolioTotals([program("100", "5", "0.05"), program("300", "15", "0.09")]);
    expect(totals.totalUsd).toBe(400);
    expect(totals.earnedUsd).toBe(20);
    expect(totals.withdrawableUsd).toBe(400);
  });

  it("weights the blended APY by balance, not by program count", () => {
    // 100 @ 5% + 300 @ 9% = 8%, not the 7% a naive average would report.
    const totals = portfolioTotals([program("100", "0", "0.05"), program("300", "0", "0.09")]);
    expect(totals.blendedApy).toBeCloseTo(0.08, 10);
  });

  /**
   * The money-honesty rule: quoting the rate of whichever programs happen to
   * publish one would present a small funded strategy's APY as the whole
   * portfolio's. A missing number renders "—", never a partial one.
   */
  it("reports no blended APY when a funded program has no rate", () => {
    const totals = portfolioTotals([program("100", "0", "0.05"), program("300", "0")]);
    expect(totals.blendedApy).toBeUndefined();
  });

  it("ignores an unrated program that holds nothing", () => {
    const totals = portfolioTotals([program("100", "0", "0.05"), program("0", "0")]);
    expect(totals.blendedApy).toBeCloseTo(0.05, 10);
  });

  it("reports no rate for an empty or all-zero portfolio", () => {
    expect(portfolioTotals([]).blendedApy).toBeUndefined();
    expect(portfolioTotals([program("0", "0", "0.05")]).blendedApy).toBeUndefined();
  });
});
