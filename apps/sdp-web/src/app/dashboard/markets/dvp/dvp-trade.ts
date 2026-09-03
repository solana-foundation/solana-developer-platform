/**
 * The DvP trade shape the dashboard consumes, and the derivations it needs.
 *
 * Every 64-bit value is a string here for the same reason it is one on the
 * wire: amounts and the nonce are u64 on chain, and a JS number rounds above
 * 2^53. Comparisons go through BigInt, never Number.
 */

export const DVP_TRADE_STATUSES = [
  "creating",
  "create_failed",
  "created",
  "partially_funded",
  "funded",
  "settled",
  "cancelled",
  "rejected",
  "expired",
  "closed_unknown",
] as const;

export type DvpTradeStatus = (typeof DVP_TRADE_STATUSES)[number];

/** What the reconciler last saw in an escrow. Null before it has looked. */
export interface DvpLegFunding {
  observedAmount: string;
  funded: boolean;
  /** Amount above the target, or null. A settlement risk, not a bonus. */
  surplus: string | null;
  frozen: boolean;
}

export interface DvpTradeLeg {
  party: string;
  mint: string;
  tokenProgram: string;
  amount: string;
  /** The address a counterparty pays into. The whole of their integration. */
  escrow: string;
  settlementDestination: string;
  funding: DvpLegFunding | null;
}

export interface DvpTrade {
  id: string;
  status: DvpTradeStatus;
  swapDvp: string;
  settlementAuthority: string;
  legs: { a: DvpTradeLeg; b: DvpTradeLeg };
  sdpSide: "a" | "b";
  nonce: string;
  expiryTimestamp: string;
  earliestSettlementTimestamp: string | null;
  refString: string | null;
  createSignature: string | null;
  observedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Statuses a trade can still be settled or cancelled from. */
const OPEN: ReadonlySet<DvpTradeStatus> = new Set([
  "created",
  "partially_funded",
  "funded",
  "expired",
]);

export function isDvpTradeOpen(trade: DvpTrade): boolean {
  return OPEN.has(trade.status);
}

/**
 * Settlement needs BOTH legs funded, which is not the same as the trade being
 * worth acting on — a half-funded trade can still be cancelled.
 */
export function canSettleDvpTrade(trade: DvpTrade): boolean {
  return trade.status === "funded";
}

export function canCancelDvpTrade(trade: DvpTrade): boolean {
  return isDvpTradeOpen(trade);
}

/** Legs holding more than their target. Settle refunds the surplus. */
export function overFundedLegs(trade: DvpTrade): DvpTradeLeg[] {
  return [trade.legs.a, trade.legs.b].filter((leg) => leg.funding?.surplus != null);
}

/** Legs whose escrow is frozen, so funding transfers into them bounce. */
export function frozenLegs(trade: DvpTrade): DvpTradeLeg[] {
  return [trade.legs.a, trade.legs.b].filter((leg) => leg.funding?.frozen === true);
}

/**
 * Funding progress as a 0..1 fraction, or null when nothing has been observed.
 *
 * Capped at 1 rather than allowed to exceed it: an over-funded leg is fully
 * funded plus a separate warning, and a bar running past its track would read
 * as "more progress" when it actually means "a settlement risk".
 */
export function legFundingRatio(leg: DvpTradeLeg): number | null {
  if (!leg.funding) {
    return null;
  }
  const target = BigInt(leg.amount);
  if (target === 0n) {
    return 1;
  }
  const observed = BigInt(leg.funding.observedAmount);
  if (observed >= target) {
    return 1;
  }
  // Scale before converting so the ratio survives values above 2^53.
  return Number((observed * 10_000n) / target) / 10_000;
}
