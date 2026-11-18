import "server-only";

import { addDecimals, isPositiveDecimal } from "../src/lib/decimal";
import type { TokenBalance, YieldPosition, YieldStrategy } from "../src/types";
import { type SolanaCluster, USDC_MINTS } from "./solana";

/**
 * Northstar offers one savings product, backed by one Embedded Yield strategy.
 * `DEMO_STRATEGY_ID` pins it; otherwise the first active, fundable strategy on
 * the configured cluster that is DeFi and uses USDC as its direct deposit mint,
 * in catalogue order. Withdrawal routes are discovered from live provider
 * state when the customer exits; `liquidityTerm` is not a route selector.
 * Nothing else qualifies: an RWA strategy, another token, or another cluster
 * would silently change the checking-and-savings model.
 */
export function pickSavingsStrategy(
  strategies: readonly YieldStrategy[],
  cluster: SolanaCluster,
  preferredId?: string
): YieldStrategy {
  if (preferredId) {
    const strategy = strategies.find((item) => item.id === preferredId);
    if (!strategy) {
      throw new Error(
        `DEMO_STRATEGY_ID ${preferredId} is not in the SDP strategy catalogue`
      );
    }
    if (strategy.hostCluster !== cluster) {
      throw new Error(
        `DEMO_STRATEGY_ID ${preferredId} is not a ${cluster} strategy`
      );
    }
    return strategy;
  }

  const strategy = strategies.find(
    (item) =>
      item.fundable &&
      item.status === "active" &&
      item.hostCluster === cluster &&
      item.sourceKind === "defi" &&
      item.depositMints[0] === USDC_MINTS[cluster]
  );
  if (!strategy) {
    throw new Error(
      `The SDP catalogue has no fundable ${cluster} DeFi strategy with a USDC deposit mint. Set DEMO_STRATEGY_ID to choose one explicitly.`
    );
  }
  return strategy;
}

export function canDeposit(strategy: YieldStrategy): boolean {
  return strategy.fundable && strategy.status === "active";
}

export function requireDepositMint(strategy: YieldStrategy): string {
  const mint = strategy.depositMints[0];
  if (!mint)
    throw new Error(`${strategy.name} does not publish a direct deposit mint`);
  return mint;
}

export function belongsToStrategy(
  position: Pick<YieldPosition, "provider" | "providerReference">,
  strategy: Pick<YieldStrategy, "provider" | "providerReference">
): boolean {
  return (
    position.provider === strategy.provider &&
    position.providerReference === strategy.providerReference
  );
}

/** A position still holding shares, or one whose live share count is unknown. */
export function isOpenPosition(position: YieldPosition): boolean {
  return position.shares === undefined || isPositiveDecimal(position.shares);
}

/** Only these observed ledger fields enter savings arithmetic. */
export interface SavingsLedgerEntry {
  direction: "deposit" | "withdrawal";
  status: "pending" | "completed" | "failed";
  tokenAmount: string | null;
}

export interface SavingsSummary {
  balance?: string;
  earned?: string;
  total?: string;
}

/**
 * Entries must be scoped to the savings strategy. Earnings equal live value
 * plus completed withdrawal payouts minus completed deposits, and remain
 * unknown while an entry is pending or an observed amount is unavailable.
 */
export function summarizeSavings(
  checking: Pick<TokenBalance, "amount">,
  position: YieldPosition | null,
  entries: readonly SavingsLedgerEntry[],
  pendingOperationWithdrawal = false
): SavingsSummary {
  const positionBalance = position ? position.tokenValue : "0";
  const queuedBalance = pendingOperationWithdrawal ? undefined : "0";
  const balance =
    positionBalance === undefined || queuedBalance === undefined
      ? undefined
      : addDecimals([positionBalance, queuedBalance]);
  return {
    balance,
    earned:
      position?.discovered || position?.costBasisKnown === false
        ? undefined
        : earnedFromLedger(balance, entries),
    total:
      balance === undefined
        ? undefined
        : addDecimals([checking.amount, balance]),
  };
}

export function earnedFromLedger(
  currentValue: string | undefined,
  entries: readonly SavingsLedgerEntry[]
): string | undefined {
  if (currentValue === undefined) return undefined;
  if (entries.some((entry) => entry.status === "pending")) return undefined;
  const completed = entries.filter((entry) => entry.status === "completed");
  const valued = completed.filter(
    (entry): entry is SavingsLedgerEntry & { tokenAmount: string } =>
      entry.tokenAmount !== null
  );
  if (valued.length !== completed.length) return undefined;
  return addDecimals([
    currentValue,
    ...valued.map((entry) =>
      entry.direction === "withdrawal"
        ? entry.tokenAmount
        : `-${entry.tokenAmount}`
    ),
  ]);
}
