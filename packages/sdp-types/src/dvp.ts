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

/**
 * Whether SDP is a party to the trade or only set it up.
 *
 * `principal` is the original shape and the default: SDP holds one leg in a
 * custody wallet and the counterparty is an arbitrary address.
 *
 * `agent` is the execution-desk shape — one party sets the terms and two other
 * parties do the swaps. The program always allowed it (`CreateDvp`'s only
 * signer is the payer), so this is SDP catching up to the program rather than
 * anything new on chain.
 */
export const DVP_TRADE_KINDS = ["principal", "agent"] as const;
export type DvpTradeKind = (typeof DVP_TRADE_KINDS)[number];
