import "server-only";

import {
  addDecimals,
  compareDecimals,
  decimalScale,
  isPositiveDecimal,
  multiplyDivideDecimals,
} from "../src/lib/decimal";
import type {
  TokenBalance,
  TokenEarnings,
  YieldPosition,
  YieldStrategy,
} from "../src/types";
import { DEVNET_USDC_MINT } from "./solana";

/** Every current stablecoin vault quotes in six-decimal tokens. */
export const SAVINGS_AMOUNT_DECIMALS = 6;
const MAX_SHARE_DECIMALS = 9;

/**
 * Northstar offers one savings product, backed by one Embedded Yield strategy.
 * `DEMO_STRATEGY_ID` pins it; otherwise prefer an instant-liquidity USDC
 * strategy so "move to checking" settles right away.
 */
export function pickSavingsStrategy(
  strategies: readonly YieldStrategy[],
  preferredId?: string
): YieldStrategy {
  if (preferredId) {
    const strategy = strategies.find((item) => item.id === preferredId);
    if (!strategy) {
      throw new Error(
        `DEMO_STRATEGY_ID ${preferredId} is not in the SDP strategy catalogue`
      );
    }
    if (strategy.hostCluster !== "devnet") {
      throw new Error(
        `DEMO_STRATEGY_ID ${preferredId} is not a devnet strategy`
      );
    }
    return strategy;
  }

  const [strategy] = strategies
    .filter(
      (item) =>
        item.fundable &&
        item.status === "active" &&
        item.hostCluster === "devnet" &&
        item.depositMints.length > 0
    )
    // Stable sort: ties keep the catalogue's own order.
    .sort(
      (left, right) =>
        rank(right, "instant") - rank(left, "instant") ||
        rank(right, DEVNET_USDC_MINT) - rank(left, DEVNET_USDC_MINT)
    );
  if (!strategy) {
    throw new Error(
      "The SDP catalogue has no fundable devnet strategy. Sync the catalogue or set DEMO_STRATEGY_ID."
    );
  }
  return strategy;
}

function rank(strategy: YieldStrategy, feature: string): number {
  return Number(
    strategy.liquidityTerm === feature || strategy.depositMints[0] === feature
  );
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

export interface SavingsSummary {
  balance?: string;
  withdrawable?: string;
  earned?: string;
  total?: string;
}

export function summarizeSavings(
  checking: Pick<TokenBalance, "amount">,
  position: YieldPosition | null,
  earnings: TokenEarnings | undefined
): SavingsSummary {
  if (!position) {
    return {
      balance: "0",
      withdrawable: "0",
      earned: earnings?.earned ?? "0",
      total: checking.amount,
    };
  }
  const balance = position.tokenValue;
  return {
    balance,
    withdrawable: withdrawableAmount(position),
    earned: earnings?.earned,
    total:
      balance === undefined
        ? undefined
        : addDecimals([checking.amount, balance]),
  };
}

/** Current token value that can be redeemed immediately, rounded down. */
export function withdrawableAmount(
  position: Pick<YieldPosition, "shares" | "withdrawableShares" | "tokenValue">
): string | undefined {
  if (
    position.shares === undefined ||
    position.withdrawableShares === undefined ||
    position.tokenValue === undefined ||
    !isPositiveDecimal(position.shares)
  ) {
    return undefined;
  }
  return multiplyDivideDecimals(
    position.withdrawableShares,
    position.tokenValue,
    position.shares,
    SAVINGS_AMOUNT_DECIMALS
  );
}

/**
 * Convert a customer's token amount into the share quantity SDP redeems.
 * A full withdrawal sends the exact withdrawable share count so nothing is
 * stranded by rounding; partial withdrawals scale by the live share price.
 */
export function sharesForAmount(
  amount: string,
  position: Pick<YieldPosition, "shares" | "withdrawableShares" | "tokenValue">
): string {
  if (
    !isPositiveDecimal(amount) ||
    decimalScale(amount) > SAVINGS_AMOUNT_DECIMALS
  ) {
    throw new Error(
      `Enter a positive amount with up to ${SAVINGS_AMOUNT_DECIMALS} decimal places`
    );
  }
  const available = withdrawableAmount(position);
  if (
    available === undefined ||
    position.shares === undefined ||
    position.withdrawableShares === undefined ||
    position.tokenValue === undefined
  ) {
    throw new Error("Savings balance is still updating; refresh and try again");
  }
  const comparison = compareDecimals(amount, available);
  if (comparison === 1) {
    throw new Error(`Only ${available} is available to move right now`);
  }
  if (comparison === 0) return position.withdrawableShares;

  const shareDecimals = Math.min(
    MAX_SHARE_DECIMALS,
    Math.max(
      SAVINGS_AMOUNT_DECIMALS,
      decimalScale(position.shares),
      decimalScale(position.withdrawableShares)
    )
  );
  const shares = multiplyDivideDecimals(
    amount,
    position.shares,
    position.tokenValue,
    shareDecimals
  );
  if (!isPositiveDecimal(shares)) {
    throw new Error("That amount is too small to move");
  }
  return shares;
}
