import type { DvpLegOutcome } from "@sdp/types";
import type { DvpTradeRow, DvpTradeSide } from "@/db/repositories";
import type { DvpLegTransfer } from "@/db/repositories/dvp-leg-transfer.repository";
import { internalError } from "@/lib/errors";

/**
 * Whether the stored escrow readings were taken after the trade closed.
 *
 * `recordClose` moves the status on the strength of a broadcast and leaves the
 * escrow balances as they were before it; the post-close reading lands only
 * once the transaction confirms. Until then a closed trade with tokens in its
 * escrow is a stale reading, not a late deposit. An open trade has no close
 * to predate.
 *
 * @param trade - The persisted trade.
 * @returns True when the readings describe the escrows after the close.
 */
export function observedAfterClose(trade: Pick<DvpTradeRow, "closedAt" | "observedAt">): boolean {
  if (trade.closedAt === null) {
    return true;
  }
  return trade.observedAt !== null && Date.parse(trade.observedAt) >= Date.parse(trade.closedAt);
}

/**
 * Derives the current outcome of one DvP leg from persisted chain observations.
 *
 * An open leg reads from its balance against its target. It reads `reclaimed`
 * only while the escrow's most recent recorded movement took tokens out and
 * the balance is short of the target, so a reclaim followed by a refund to the
 * target reads funded, a reclaim followed by a partial refund reads partial,
 * and a deposit reclaimed between two observations still reads reclaimed. The
 * peak balance on the row is not consulted: a high-water mark cannot tell a
 * reclaim that was refunded from one that was not.
 *
 * @param trade - The persisted trade and its latest escrow observations.
 * @param side - The leg to derive.
 * @param transfers - The leg's recorded escrow movements, oldest first.
 * @returns The server-owned leg outcome.
 */
export function deriveDvpLegOutcome(
  trade: DvpTradeRow,
  side: DvpTradeSide,
  transfers: readonly Pick<DvpLegTransfer, "direction">[]
): DvpLegOutcome {
  const amount = side === "a" ? trade.escrowAAmount : trade.escrowBAmount;
  const frozen = side === "a" ? trade.escrowAFrozen : trade.escrowBFrozen;
  const target = side === "a" ? trade.amountA : trade.amountB;

  // Every closed trade checks its escrow first. Settle, Cancel and Reject all
  // close the escrow, so a balance under a closed trade can only be a deposit
  // that landed afterwards into a re-created account, and only RecoverDvp can
  // move it. Reporting the leg as delivered or refunded would hide those funds.
  const holdsTokens = amount !== null && BigInt(amount) > 0n && observedAfterClose(trade);
  switch (trade.status) {
    case "settled":
      return holdsTokens ? "recoverable" : "delivered";
    case "cancelled":
    case "rejected":
      return holdsTokens ? "recoverable" : "refunded";
    case "closed_unknown":
    case "create_failed":
      return holdsTokens ? "recoverable" : "closed";
    case "creating":
    case "created":
    case "partially_funded":
    case "funded":
    case "expired":
      if (frozen === true) {
        return "frozen";
      }
      break;
    default: {
      const unreachable: never = trade.status;
      throw internalError(`Unhandled DvP trade status ${String(unreachable)}`);
    }
  }

  // With no movement recorded yet (the escrow's history has not been read, or
  // the ledger is a sweep behind the observation) there is no evidence that
  // anything left the escrow. The balance is the one chain fact held, so the
  // leg reads from it alone rather than guessing at a reclaim.
  const latest = transfers.at(-1);
  if (latest?.direction === "out" && amount !== null && BigInt(amount) < BigInt(target)) {
    return "reclaimed";
  }
  if (trade.status === "expired") {
    return "expired";
  }
  if (amount === null || BigInt(amount) === 0n) {
    return "awaiting";
  }
  if (BigInt(amount) < BigInt(target)) {
    return "partial";
  }
  if (BigInt(amount) === BigInt(target)) {
    return "funded";
  }
  return "overfunded";
}
