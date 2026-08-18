import { describe, expect, it } from "vitest";
import {
  applyStrategyTransaction,
  parseUsdcMicros,
  type StrategyTransactionMode,
  type TreasuryMockState,
  totalTreasuryValueMicros,
  USDC_MICROS,
} from "./treasury-solutions-model";

function treasuryState(): TreasuryMockState {
  return {
    walletUsdcMicros: 10 * USDC_MICROS,
    strategies: [
      {
        id: "alpha",
        name: "Alpha strategy",
        asset: "USDC",
        apyPercent: 5.5,
        balanceMicros: 4 * USDC_MICROS,
      },
      {
        id: "beta",
        name: "Beta strategy",
        asset: "PYUSD",
        apyPercent: 7.25,
        balanceMicros: 2 * USDC_MICROS,
      },
    ],
  };
}

function successfulTransaction(
  state: TreasuryMockState,
  input: {
    strategyId: string;
    mode: StrategyTransactionMode;
    amountMicros: number | null;
  }
): TreasuryMockState {
  const result = applyStrategyTransaction(state, input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected transaction to succeed, received ${result.error}`);
  return result.state;
}

describe("parseUsdcMicros", () => {
  it.each<[string, number]>([
    ["1", 1_000_000],
    ["1.2", 1_200_000],
    ["12.345678", 12_345_678],
    ["0.000001", 1],
    [" 42.000001 ", 42_000_001],
  ])("parses %j exactly to six-decimal USDC micros", (input, expected) => {
    expect(parseUsdcMicros(input)).toBe(expected);
  });

  it.each(["", "0", "0.000000", "1.0000001", ".5", "-1", "1e3", "1,000", "abc"])(
    "rejects invalid amount %j",
    (input) => {
      expect(parseUsdcMicros(input)).toBeNull();
    }
  );
});

describe("applyStrategyTransaction", () => {
  it("deposits from the wallet into only the chosen strategy", () => {
    const before = treasuryState();
    const after = successfulTransaction(before, {
      strategyId: "alpha",
      mode: "deposit",
      amountMicros: 1_250_000,
    });

    expect(after.walletUsdcMicros).toBe(8_750_000);
    expect(after.strategies.find((strategy) => strategy.id === "alpha")?.balanceMicros).toBe(
      5_250_000
    );
    expect(after.strategies.find((strategy) => strategy.id === "beta")?.balanceMicros).toBe(
      2_000_000
    );
    expect(before).toEqual(treasuryState());
  });

  it("withdraws from only the chosen strategy back into the wallet", () => {
    const before = treasuryState();
    const after = successfulTransaction(before, {
      strategyId: "beta",
      mode: "withdraw",
      amountMicros: 750_000,
    });

    expect(after.walletUsdcMicros).toBe(10_750_000);
    expect(after.strategies.find((strategy) => strategy.id === "alpha")?.balanceMicros).toBe(
      4_000_000
    );
    expect(after.strategies.find((strategy) => strategy.id === "beta")?.balanceMicros).toBe(
      1_250_000
    );
    expect(before).toEqual(treasuryState());
  });

  it.each<{
    mode: StrategyTransactionMode;
    strategyId: string;
    amountMicros: number;
  }>([
    { mode: "deposit", strategyId: "alpha", amountMicros: 3_500_000 },
    { mode: "withdraw", strategyId: "beta", amountMicros: 1_500_000 },
  ])("conserves total value after a $mode", (input) => {
    const before = treasuryState();
    const after = successfulTransaction(before, input);

    expect(totalTreasuryValueMicros(after)).toBe(totalTreasuryValueMicros(before));
  });

  it("rejects a deposit larger than the wallet balance", () => {
    expect(
      applyStrategyTransaction(treasuryState(), {
        strategyId: "alpha",
        mode: "deposit",
        amountMicros: 10 * USDC_MICROS + 1,
      })
    ).toEqual({ ok: false, error: "insufficient_wallet_balance" });
  });

  it("rejects a withdrawal larger than the chosen strategy balance", () => {
    expect(
      applyStrategyTransaction(treasuryState(), {
        strategyId: "beta",
        mode: "withdraw",
        amountMicros: 2 * USDC_MICROS + 1,
      })
    ).toEqual({ ok: false, error: "insufficient_strategy_balance" });
  });

  it.each([null, 0, -1, 1.5, Number.NaN])("rejects invalid amount %s", (amountMicros) => {
    expect(
      applyStrategyTransaction(treasuryState(), {
        strategyId: "alpha",
        mode: "deposit",
        amountMicros,
      })
    ).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("rejects an unknown strategy", () => {
    expect(
      applyStrategyTransaction(treasuryState(), {
        strategyId: "missing",
        mode: "deposit",
        amountMicros: USDC_MICROS,
      })
    ).toEqual({ ok: false, error: "strategy_not_found" });
  });
});
