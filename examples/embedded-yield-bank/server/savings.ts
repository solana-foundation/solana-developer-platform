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
  YieldMovement,
  YieldPosition,
  YieldStrategy,
  YieldWithdrawalOptions,
  YieldWithdrawalRequest,
} from "../src/types";
import { ApiRequestError } from "./http";
import { type SolanaCluster, USDC_MINTS } from "./solana";

/** Every current stablecoin vault quotes in six-decimal tokens. */
export const SAVINGS_AMOUNT_DECIMALS = 6;
const MAX_SHARE_DECIMALS = 9;

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

export interface SavingsSummary {
  balance?: string;
  withdrawable?: string;
  earned?: string;
  total?: string;
}

/**
 * `movements` must already be scoped to the savings strategy. Earnings follow
 * SDP's own rule for a wallet, applied to this one strategy: live value plus
 * finalized withdrawal payouts minus finalized deposits, stated only when it
 * is exact (no pending movement, no unvalued payout, no missing valuation).
 * SDP's earnings endpoint groups by token across every strategy the wallet
 * touches, which is the wrong scope for a single savings account.
 */
export function summarizeSavings(
  checking: Pick<TokenBalance, "amount">,
  position: YieldPosition | null,
  movements: readonly YieldMovement[],
  withdrawalRequests: readonly YieldWithdrawalRequest[] = []
): SavingsSummary {
  const positionBalance = position ? position.tokenValue : "0";
  const queuedBalance = queuedWithdrawalValue(withdrawalRequests);
  const balance =
    positionBalance === undefined || queuedBalance === undefined
      ? undefined
      : addDecimals([positionBalance, queuedBalance]);
  return {
    balance,
    withdrawable: position ? withdrawableAmount(position) : "0",
    earned: earnedFromLedger(balance, movements),
    total:
      balance === undefined
        ? undefined
        : addDecimals([checking.amount, balance]),
  };
}

/**
 * Expected value still owned by the customer while shares sit in queue
 * escrow. Creating and closed-or-unknown requests stay unvalued because adding
 * either would guess whether the wallet shares or asset payout already count.
 */
export function queuedWithdrawalValue(
  requests: readonly YieldWithdrawalRequest[]
): string | undefined {
  if (
    requests.some(
      (request) =>
        request.status === "creating" || request.status === "closedOrUnknown"
    )
  ) {
    return undefined;
  }
  return addDecimals(
    requests
      .filter((request) =>
        ["pending", "fulfillable", "expiredCancelable", "cancelling"].includes(
          request.status
        )
      )
      .map((request) => request.quotedAssets)
  );
}

/** Refuse stale or out-of-range queue choices before asking SDP to build. */
export function assertQueuedWithdrawalTerms(
  options: YieldWithdrawalOptions,
  shares: string,
  discountBps: number,
  deadlineSeconds: number
): void {
  const terms = options.queueAsset;
  if (!options.queued || !terms?.allowWithdrawals) {
    throw new ApiRequestError(
      400,
      "WITHDRAWAL_ROUTE_UNAVAILABLE",
      "Queued withdrawals are not currently available"
    );
  }
  if (compareDecimals(shares, terms.minimumShares) === -1) {
    throw new ApiRequestError(
      400,
      "INVALID_REQUEST",
      `Queued withdrawals require at least ${terms.minimumShares} shares`
    );
  }
  if (
    !Number.isInteger(discountBps) ||
    discountBps < terms.minimumDiscountBps ||
    discountBps > terms.maximumDiscountBps
  ) {
    throw new ApiRequestError(
      400,
      "INVALID_REQUEST",
      `Choose a discount from ${terms.minimumDiscountBps} to ${terms.maximumDiscountBps} basis points`
    );
  }
  if (
    !Number.isInteger(deadlineSeconds) ||
    deadlineSeconds < terms.minimumSecondsToDeadline ||
    deadlineSeconds > terms.maximumSecondsToDeadline
  ) {
    throw new ApiRequestError(
      400,
      "INVALID_REQUEST",
      `Choose a solver window from ${terms.minimumSecondsToDeadline} to ${terms.maximumSecondsToDeadline} seconds`
    );
  }
}

export function earnedFromLedger(
  currentValue: string | undefined,
  movements: readonly YieldMovement[]
): string | undefined {
  if (currentValue === undefined) return undefined;
  if (movements.some((movement) => isPendingMovement(movement)))
    return undefined;
  const finalized = movements.filter(
    (movement) => movement.status === "finalized"
  );
  const valued = finalized.filter(
    (movement): movement is YieldMovement & { tokenAmount: string } =>
      movement.tokenAmount !== null
  );
  if (valued.length !== finalized.length) return undefined;
  return addDecimals([
    currentValue,
    ...valued.map((movement) =>
      movement.direction === "withdrawal"
        ? movement.tokenAmount
        : `-${movement.tokenAmount}`
    ),
  ]);
}

function isPendingMovement(movement: YieldMovement): boolean {
  return movement.status !== "finalized" && movement.status !== "failed";
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
    throw new ApiRequestError(
      400,
      "INVALID_REQUEST",
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
    // Missing valuation fields are provider state, not malformed client
    // input, so report a retryable 503 instead of a client-correcting 400.
    throw new ApiRequestError(
      503,
      "VALUATION_UNAVAILABLE",
      "Savings balance is still updating; refresh and try again"
    );
  }
  const comparison = compareDecimals(amount, available);
  if (comparison === 1) {
    throw new ApiRequestError(
      400,
      "INVALID_REQUEST",
      `Only ${available} is available to move right now`
    );
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
    throw new ApiRequestError(
      400,
      "INVALID_REQUEST",
      "That amount is too small to move"
    );
  }
  return shares;
}
