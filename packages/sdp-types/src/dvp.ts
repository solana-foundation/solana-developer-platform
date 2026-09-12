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

/**
 * Why a request to fund a DvP leg was refused, sent as `error.details.reason`.
 *
 * The message carries ids and addresses for logs; a client names the problem in
 * its own words from this code instead of relaying that message.
 */
export const DVP_FUND_REFUSAL = {
  /** The trade is past the point where funding means anything. */
  tradeNotFundable: "dvp_trade_not_fundable",
  tradeNotOnChain: "dvp_trade_not_on_chain",
  /** The account at the trade's address carries terms the row did not record. */
  termsMismatch: "dvp_terms_mismatch",
  escrowMissing: "dvp_escrow_missing",
  /** The escrow is not the trade's token account (owner, mint or program). */
  escrowMismatch: "dvp_escrow_mismatch",
  escrowFrozen: "dvp_escrow_frozen",
  legAlreadyFunded: "dvp_leg_already_funded",
  mintUnreadable: "dvp_mint_unreadable",
  /** The paying wallet has no token account for the leg's mint. */
  walletHoldsNoToken: "dvp_wallet_holds_no_token",
  walletBalanceShort: "dvp_wallet_balance_short",
  /** A deposit landed between the balance read and the send. */
  escrowBalanceChanged: "dvp_escrow_balance_changed",
  legFundingInProgress: "dvp_leg_funding_in_progress",
} as const;
export type DvpFundRefusalReason = (typeof DVP_FUND_REFUSAL)[keyof typeof DVP_FUND_REFUSAL];
