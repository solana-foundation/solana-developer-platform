import type { DvpLegTransferKind } from "@sdp/types";
import type { DvpTradeRow } from "@/db/repositories";
import type { DvpLegTransfer } from "@/db/repositories/dvp-leg-transfer.repository";
import { internalError } from "@/lib/errors";

/**
 * What the closing transaction's outflow was, by how the trade closed, or null
 * for a trade that has not closed.
 */
function closingKind(status: DvpTradeRow["status"]): DvpLegTransferKind | null {
  switch (status) {
    case "settled":
      return "delivery";
    case "cancelled":
    case "rejected":
      return "refund";
    case "closed_unknown":
    case "create_failed":
      return "withdrawal";
    case "creating":
    case "created":
    case "partially_funded":
    case "funded":
    case "expired":
      return null;
    default: {
      const unreachable: never = status;
      throw internalError(`Unhandled DvP trade status ${String(unreachable)}`);
    }
  }
}

/**
 * Names each of a leg's transfers, oldest first (PRO-1941).
 *
 * Into the escrow is always a deposit. Out of an open trade's escrow only a
 * reclaim moves tokens. On a closed trade the closing transaction is the
 * delivery or refund; an outflow before it was a reclaim, and one after it can
 * only be a late deposit recovered. When the closing transaction is not among
 * the transfers (not recorded yet, or a close the reconciler never resolved)
 * no outflow can be placed against it, so each reads as a withdrawal rather
 * than a name it may not have earned.
 *
 * @param trade - The trade's status and the transaction that closed it.
 * @param transfers - The leg's transfers, oldest first.
 * @returns Each transfer with its kind, in the same order.
 */
export function deriveDvpLegTransferKinds<
  T extends Pick<DvpLegTransfer, "direction" | "signature">,
>(
  trade: Pick<DvpTradeRow, "status" | "closeSignature">,
  transfers: readonly T[]
): { transfer: T; kind: DvpLegTransferKind }[] {
  const closing = closingKind(trade.status);
  const closingIndex =
    trade.closeSignature === null
      ? -1
      : transfers.findIndex((transfer) => transfer.signature === trade.closeSignature);
  return transfers.map((transfer, index) => {
    if (transfer.direction === "in") {
      return { transfer, kind: "deposit" };
    }
    if (closing === null) {
      return { transfer, kind: "reclaim" };
    }
    if (closingIndex === -1) {
      return { transfer, kind: "withdrawal" };
    }
    if (index === closingIndex) {
      return { transfer, kind: closing };
    }
    return { transfer, kind: index < closingIndex ? "reclaim" : "recovery" };
  });
}
