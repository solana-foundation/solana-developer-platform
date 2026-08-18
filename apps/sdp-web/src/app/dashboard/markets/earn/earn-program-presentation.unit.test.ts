import type { EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { portfolioTotals, programTitle, strategiesByReference } from "./earn-program-presentation";

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
    hostCluster: "devnet",
    fundable: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...partial,
  };
}

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
