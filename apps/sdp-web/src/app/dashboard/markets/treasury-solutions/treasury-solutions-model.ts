export const USDC_MICROS = 1_000_000;

export type StrategyAsset = "PYUSD" | "USDG" | "USDC";
export type StrategyTransactionMode = "deposit" | "withdraw";

export interface TreasuryStrategy {
  id: string;
  name: string;
  asset: StrategyAsset;
  apyPercent: number;
  balanceMicros: number;
}

export interface TreasuryMockState {
  walletUsdcMicros: number;
  strategies: TreasuryStrategy[];
}

export type StrategyTransactionError =
  | "invalid_amount"
  | "insufficient_wallet_balance"
  | "insufficient_strategy_balance"
  | "strategy_not_found";

export type StrategyTransactionResult =
  | { ok: true; state: TreasuryMockState }
  | { ok: false; error: StrategyTransactionError };

export const INITIAL_TREASURY_STATE: TreasuryMockState = {
  walletUsdcMicros: 4_250_000 * USDC_MICROS,
  strategies: [
    {
      id: "ethena-pyusd-prime",
      name: "Ethena PYUSD Prime",
      asset: "PYUSD",
      apyPercent: 8.6,
      balanceMicros: 650_000 * USDC_MICROS,
    },
    {
      id: "sentora-pyusd",
      name: "Sentora PYUSD",
      asset: "PYUSD",
      apyPercent: 7.4,
      balanceMicros: 225_000 * USDC_MICROS,
    },
    {
      id: "steakhouse-usdg-high-yield",
      name: "Steakhouse USDG High Yield",
      asset: "USDG",
      apyPercent: 8.1,
      balanceMicros: 0,
    },
    {
      id: "steakhouse-usdc",
      name: "Steakhouse USDC",
      asset: "USDC",
      apyPercent: 4.8,
      balanceMicros: 800_000 * USDC_MICROS,
    },
    {
      id: "steakhouse-usdc-high-yield",
      name: "Steakhouse USDC High Yield",
      asset: "USDC",
      apyPercent: 6.7,
      balanceMicros: 375_000 * USDC_MICROS,
    },
  ],
};

/** Parses a decimal USDC input without introducing floating-point rounding. */
export function parseUsdcMicros(input: string): number | null {
  const normalized = input.trim();
  if (!/^\d+(?:\.\d{0,6})?$/.test(normalized)) return null;

  const [wholePart, fractionalPart = ""] = normalized.split(".");
  const wholeMicros = Number(wholePart) * USDC_MICROS;
  const fractionalMicros = Number(fractionalPart.padEnd(6, "0"));
  const amountMicros = wholeMicros + fractionalMicros;

  return Number.isSafeInteger(amountMicros) && amountMicros > 0 ? amountMicros : null;
}

/** Applies one browser-only strategy transaction while conserving mock USDC value. */
export function applyStrategyTransaction(
  state: TreasuryMockState,
  input: {
    strategyId: string;
    mode: StrategyTransactionMode;
    amountMicros: number | null;
  }
): StrategyTransactionResult {
  const { amountMicros, mode, strategyId } = input;
  if (!amountMicros || !Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
    return { ok: false, error: "invalid_amount" };
  }

  const strategyIndex = state.strategies.findIndex((strategy) => strategy.id === strategyId);
  if (strategyIndex < 0) return { ok: false, error: "strategy_not_found" };

  const strategy = state.strategies[strategyIndex];
  if (!strategy) return { ok: false, error: "strategy_not_found" };

  if (mode === "deposit" && amountMicros > state.walletUsdcMicros) {
    return { ok: false, error: "insufficient_wallet_balance" };
  }
  if (mode === "withdraw" && amountMicros > strategy.balanceMicros) {
    return { ok: false, error: "insufficient_strategy_balance" };
  }

  const direction = mode === "deposit" ? 1 : -1;
  const strategies = state.strategies.map((entry, index) =>
    index === strategyIndex
      ? {
          ...entry,
          balanceMicros: entry.balanceMicros + direction * amountMicros,
        }
      : entry
  );

  return {
    ok: true,
    state: {
      walletUsdcMicros: state.walletUsdcMicros - direction * amountMicros,
      strategies,
    },
  };
}

export function totalTreasuryValueMicros(state: TreasuryMockState): number {
  return (
    state.walletUsdcMicros +
    state.strategies.reduce((total, strategy) => total + strategy.balanceMicros, 0)
  );
}
