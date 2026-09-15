/**
 * DvP (delivery-versus-payment) trade lifecycle constants.
 *
 * Registries follow ADR 0001 (asset profiles): closed unions defined in code,
 * open TEXT columns in Postgres, Zod validation at the app layer — adding a new
 * kind is a code change, never a migration.
 */

/**
 * Last observed lifecycle state of a DvP trade.
 *
 * A cache of a poll, never an event. The program emits no events and funding
 * never invokes it, so every non-terminal status here is what the reconciler
 * last observed, not something the program announced.
 */
export const DVP_TRADE_STATUSES = [
  /** Signed and recorded, broadcast outcome not yet known. The initial state. */
  "creating",
  /** The create transaction was rejected before it could land. Nothing exists. */
  "create_failed",
  "created",
  "partially_funded",
  "funded",
  "settled",
  "cancelled",
  "rejected",
  "expired",
  /** PDA is gone but which terminal path closed it is not yet known. */
  "closed_unknown",
] as const;
export type DvpTradeStatus = (typeof DVP_TRADE_STATUSES)[number];

/** DvP trade statuses that can receive another funding leg. */
export const FUNDABLE_DVP_TRADE_STATUSES = [
  "created",
  "partially_funded",
] as const satisfies readonly DvpTradeStatus[];

/** DvP trade statuses from which settlement or cancellation remains possible. */
export const OPEN_DVP_TRADE_STATUSES = [
  "created",
  "partially_funded",
  "funded",
  "expired",
] as const satisfies readonly DvpTradeStatus[];

/** DvP trade statuses representing creation or an open trade. */
export const ACTIVE_DVP_TRADE_STATUSES = [
  "creating",
  ...OPEN_DVP_TRADE_STATUSES,
] as const satisfies readonly DvpTradeStatus[];

/** DvP trade statuses whose chain outcome can still refine stored state. */
export const OBSERVABLE_DVP_TRADE_STATUSES = [
  ...OPEN_DVP_TRADE_STATUSES,
  "closed_unknown",
] as const satisfies readonly DvpTradeStatus[];

/** DvP trade statuses eligible for the recent-closure activity window. */
export const RECENTLY_CLOSED_DVP_TRADE_STATUSES = [
  "settled",
  "cancelled",
  "rejected",
  "closed_unknown",
] as const satisfies readonly DvpTradeStatus[];

/** Closed DvP trade statuses with a definitive decoded outcome. */
export const RESOLVED_CLOSED_DVP_TRADE_STATUSES = [
  "settled",
  "cancelled",
  "rejected",
] as const satisfies readonly DvpTradeStatus[];

/** DvP trade statuses whose escrow may still hold unsettled value. */
export const UNSETTLED_DVP_TRADE_STATUSES = [
  "created",
  "partially_funded",
  "funded",
] as const satisfies readonly DvpTradeStatus[];

/** DvP trade statuses whose escrows no longer exist. */
export const CLOSED_DVP_TRADE_STATUSES = [
  "settled",
  "cancelled",
  "rejected",
  "closed_unknown",
  "create_failed",
] as const satisfies readonly DvpTradeStatus[];

/** Reports whether a trade can receive another funding leg. */
export function isFundableDvpTradeStatus(status: DvpTradeStatus): boolean {
  return FUNDABLE_DVP_TRADE_STATUSES.some((candidate) => candidate === status);
}

/** Reports whether a trade can still be settled or cancelled. */
export function isOpenDvpTradeStatus(status: DvpTradeStatus): boolean {
  return OPEN_DVP_TRADE_STATUSES.some((candidate) => candidate === status);
}

/** Reports whether a trade is finished and its escrows no longer exist. */
export function isClosedDvpTradeStatus(status: DvpTradeStatus): boolean {
  return CLOSED_DVP_TRADE_STATUSES.some((candidate) => candidate === status);
}

/** Which leg of a DvP trade SDP holds. The other side is an arbitrary external address. */
export const DVP_TRADE_SIDES = ["a", "b"] as const;
export type DvpTradeSide = (typeof DVP_TRADE_SIDES)[number];

/** The server-derived state of one DvP leg. */
export const DVP_LEG_OUTCOMES = [
  /** No tokens have been observed in escrow. */
  "awaiting",
  /** Escrow holds less than the trade requires. */
  "partial",
  /** Escrow holds exactly the required amount. */
  "funded",
  /** Escrow holds more than the trade requires. */
  "overfunded",
  /** The escrow token account is frozen. */
  "frozen",
  /** A previously observed deposit has been reclaimed. */
  "reclaimed",
  /** The open trade expired before settlement. */
  "expired",
  /** Settlement delivered this leg to its destination. */
  "delivered",
  /** Cancellation or rejection refunded this leg. */
  "refunded",
  /** A post-close deposit remains available for recovery. */
  "recoverable",
  /** The trade closed without a recoverable balance or known outcome. */
  "closed",
] as const;
export type DvpLegOutcome = (typeof DVP_LEG_OUTCOMES)[number];
