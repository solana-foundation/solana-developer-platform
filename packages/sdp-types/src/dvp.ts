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
 * Whether a DvP trade can settle, derived by the API from the cluster clock read
 * with the trade's last observation. The program judges `earliest <= now <=
 * expiry` by its own `Clock`, so this is the one answer the status badge, the
 * list filter and the Settle action all read, never a host or browser clock.
 */
export const DVP_SETTLEMENT_AVAILABILITY = [
  /** Both legs funded and inside the window: Settle will be accepted. */
  "available",
  /** At least one leg still short of its target. */
  "unfunded",
  /** Both legs funded, but the earliest settlement time is still ahead. */
  "too_early",
  /** Past expiry: only Cancel (or a reclaim) can move the money. */
  "expired",
] as const;
export type DvpSettlementAvailability = (typeof DVP_SETTLEMENT_AVAILABILITY)[number];

/**
 * Why a request to act on one DvP leg (fund it, or reclaim it) was refused, sent
 * as `error.details.reason`.
 *
 * The message carries ids and addresses for logs; a client names the problem in
 * its own words from this code instead of relaying that message.
 */
export const DVP_LEG_REFUSAL = {
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
  /** The trade is closed, so its escrows are gone and there is nothing to pull back. */
  tradeNotReclaimable: "dvp_trade_not_reclaimable",
  /** The leg's escrow holds nothing. */
  nothingToReclaim: "dvp_leg_nothing_to_reclaim",
  /**
   * The custody wallet resolved for the side no longer signs as that side's
   * party address, and the program accepts no other signer.
   */
  signerNotParty: "dvp_signer_not_party",
  /** A settle or cancel is in flight on the trade, and the leg would move under it. */
  tradeClosing: "dvp_trade_closing",
  /**
   * The leg's mint carries a transfer hook, whose extra accounts SDP does not
   * resolve, so the refund transfer would be refused by the token program.
   */
  transferHookUnsupported: "dvp_transfer_hook_unsupported",
} as const;
export type DvpLegRefusalReason = (typeof DVP_LEG_REFUSAL)[keyof typeof DVP_LEG_REFUSAL];

/**
 * Why a settle or cancel was refused before it was sent, as `error.details.reason`.
 */
export const DVP_CLOSE_REFUSAL = {
  /** Another settle or cancel already holds the trade. */
  closeInProgress: "dvp_close_in_progress",
  /** A funding or reclaim of one of the legs has not landed yet. */
  legMoving: "dvp_leg_moving",
  /** The close reached the chain and the program refused it; nothing moved. */
  closeFailedOnChain: "dvp_close_failed_on_chain",
} as const;
export type DvpCloseRefusalReason = (typeof DVP_CLOSE_REFUSAL)[keyof typeof DVP_CLOSE_REFUSAL];
