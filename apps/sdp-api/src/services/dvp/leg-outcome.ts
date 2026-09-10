import type { DvpLegOutcome } from "@sdp/types";
import type { DvpTradeRow, DvpTradeSide } from "@/db/repositories";
import { internalError } from "@/lib/errors";

/**
 * Derives the current outcome of one DvP leg from persisted chain observations.
 *
 * @param trade - The persisted trade and its latest escrow observations.
 * @param side - The leg to derive.
 * @returns The server-owned leg outcome.
 */
export function deriveDvpLegOutcome(trade: DvpTradeRow, side: DvpTradeSide): DvpLegOutcome {
  const amount = side === "a" ? trade.escrowAAmount : trade.escrowBAmount;
  const peakAmount = side === "a" ? trade.escrowAPeakAmount : trade.escrowBPeakAmount;
  const frozen = side === "a" ? trade.escrowAFrozen : trade.escrowBFrozen;
  const target = side === "a" ? trade.amountA : trade.amountB;

  switch (trade.status) {
    case "settled":
      return "delivered";
    case "cancelled":
    case "rejected":
      return "refunded";
    case "closed_unknown":
    case "create_failed":
      return amount !== null && BigInt(amount) > 0n ? "recoverable" : "closed";
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

  if (amount !== null && peakAmount !== null && BigInt(amount) < BigInt(peakAmount)) {
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
