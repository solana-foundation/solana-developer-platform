import { describe, expect, it } from "vitest";
import type { YieldPosition, YieldStrategy } from "../src/types";
import {
  earnedFromLedger,
  pickSavingsStrategy,
  type SavingsLedgerEntry,
  summarizeSavings,
} from "./savings";
import { USDC_MINTS } from "./solana";

describe("savings strategy", () => {
  it("picks the first fundable DeFi USDC strategy without inferring its exit route", () => {
    const strategies = [
      strategy({ id: "rwa-usdc", sourceKind: "rwa" }),
      strategy({ id: "veda-delayed", liquidityTerm: "delayed" }),
      strategy({ id: "eurc-instant", depositMints: ["eurc"] }),
      strategy({ id: "mainnet", hostCluster: "mainnet-beta" }),
      strategy({ id: "paused", status: "paused" }),
      strategy({ id: "kamino-usdc" }),
      strategy({ id: "steakhouse-usdc" }),
    ];

    expect(pickSavingsStrategy(strategies, "devnet").id).toBe("veda-delayed");
  });

  it("picks a mainnet USDC strategy when mainnet is configured", () => {
    const strategies = [
      strategy({ id: "devnet", hostCluster: "devnet" }),
      strategy({
        id: "mainnet-rwa",
        sourceKind: "rwa",
        hostCluster: "mainnet-beta",
        depositMints: [USDC_MINTS["mainnet-beta"]],
      }),
      strategy({
        id: "mainnet",
        hostCluster: "mainnet-beta",
        depositMints: [USDC_MINTS["mainnet-beta"]],
      }),
    ];

    expect(pickSavingsStrategy(strategies, "mainnet-beta").id).toBe("mainnet");
  });

  it("refuses to fall back to an RWA or non-USDC strategy", () => {
    const strategies = [
      strategy({ id: "rwa-usdc", sourceKind: "rwa" }),
      strategy({ id: "eurc-instant", depositMints: ["eurc"] }),
    ];

    expect(() => pickSavingsStrategy(strategies, "devnet")).toThrow(
      "with a USDC deposit mint"
    );
  });

  it("honours DEMO_STRATEGY_ID even when it is paused for deposits", () => {
    const strategies = [
      strategy({ id: "kamino-usdc" }),
      strategy({ id: "veda-usdc", status: "paused" }),
    ];

    expect(pickSavingsStrategy(strategies, "devnet", "veda-usdc").id).toBe(
      "veda-usdc"
    );
    expect(() => pickSavingsStrategy(strategies, "devnet", "missing")).toThrow(
      "not in the SDP strategy catalogue"
    );
  });

  it("rejects an explicitly pinned strategy from another cluster", () => {
    expect(() =>
      pickSavingsStrategy(
        [strategy({ id: "mainnet", hostCluster: "mainnet-beta" })],
        "devnet",
        "mainnet"
      )
    ).toThrow("is not a devnet strategy");
  });

  it("explains an empty catalogue", () => {
    expect(() => pickSavingsStrategy([], "devnet")).toThrow(
      "Set DEMO_STRATEGY_ID"
    );
  });
});

describe("savings summary", () => {
  it("reports an empty savings account against checking", () => {
    expect(summarizeSavings({ amount: "20" }, null, [])).toEqual({
      balance: "0",
      earned: "0",
      total: "20",
    });
  });

  it("adds the live position value to checking and earns from the ledger", () => {
    expect(
      summarizeSavings(
        { amount: "19.35" },
        position({
          shares: "0.65",
          tokenValue: "0.66",
        }),
        [entry("deposit", "completed", "0.65")]
      )
    ).toEqual({
      balance: "0.66",
      earned: "0.01",
      total: "20.01",
    });
  });

  it.each([true, false])(
    "does not call pre-existing principal earned interest after tracking changes (discovered=%s)",
    (discovered) => {
      const summary = summarizeSavings(
        { amount: "10" },
        position({
          discovered,
          costBasisKnown: false,
          createdAt: null,
          shares: "50",
          tokenValue: "50",
        }),
        []
      );
      expect(summary.balance).toBe("50");
      expect(summary.total).toBe("60");
      expect(summary.earned).toBeUndefined();
    }
  );

  it("leaves totals undefined while the valuation is unavailable", () => {
    expect(summarizeSavings({ amount: "19.35" }, position({}), [])).toEqual({
      balance: undefined,
      earned: undefined,
      total: undefined,
    });
  });

  it("keeps a queued payout quote out of current value and earnings", () => {
    expect(
      summarizeSavings(
        { amount: "10" },
        position({ shares: "5", tokenValue: "5" }),
        [entry("deposit", "completed", "9.95")],
        true
      )
    ).toEqual({
      balance: undefined,
      earned: undefined,
      total: undefined,
    });
  });

  it("does not guess a balance while a queue close is unclassified", () => {
    expect(
      summarizeSavings(
        { amount: "10" },
        position({ shares: "5", tokenValue: "5" }),
        [],
        true
      )
    ).toEqual({
      balance: undefined,
      earned: undefined,
      total: undefined,
    });
  });
});

describe("earnings from the strategy ledger", () => {
  it("counts payouts of finalized withdrawals and ignores failures", () => {
    expect(
      earnedFromLedger("1.5", [
        entry("withdrawal", "completed", "1.5"),
        entry("deposit", "completed", "2"),
        entry("deposit", "completed", "1"),
        entry("deposit", "failed", "5"),
      ])
    ).toBe("0");
  });

  it("states realized earnings for a closed position", () => {
    expect(
      earnedFromLedger("0", [
        entry("withdrawal", "completed", "10.4"),
        entry("deposit", "completed", "10"),
      ])
    ).toBe("0.4");
  });

  it("is unstatable while a movement is pending or a payout is unvalued", () => {
    expect(
      earnedFromLedger("1", [entry("deposit", "pending", "1")])
    ).toBeUndefined();
    expect(
      earnedFromLedger("1", [entry("withdrawal", "completed", null)])
    ).toBeUndefined();
  });
});

function strategy(overrides: Partial<YieldStrategy>): YieldStrategy {
  return {
    id: "strategy",
    provider: "provider",
    providerReference: "vault",
    name: "Strategy",
    sourceKind: "defi",
    depositMints: [USDC_MINTS.devnet],
    liquidityTerm: "instant",
    status: "active",
    hostCluster: "devnet",
    fundable: true,
    depositSlippage: null,
    withdrawalSlippage: null,
    ...overrides,
  };
}

function position(overrides: Partial<YieldPosition>): YieldPosition {
  return {
    id: "position",
    ownerAddress: "owner",
    provider: "provider",
    providerReference: "vault",
    label: "Savings",
    tokenMint: USDC_MINTS.devnet,
    shareMint: "shares",
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

function entry(
  direction: SavingsLedgerEntry["direction"],
  status: SavingsLedgerEntry["status"],
  tokenAmount: string | null
): SavingsLedgerEntry {
  return { direction, status, tokenAmount };
}
