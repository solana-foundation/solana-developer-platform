import { z } from "zod";
import type { RampOnchainTransfer, RampSettlementEvent } from "#/ramps/types";

const HERCLE_ORDER_STATUS = {
  awaiting_payment: "awaiting_payment",
  settling: "settling",
  settled: "settled",
  failed: "failed",
  expired: "expired",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;

function isTrackedHercleOrderStatus(status: string): status is keyof typeof HERCLE_ORDER_STATUS {
  return Object.hasOwn(HERCLE_ORDER_STATUS, status);
}

/**
 * SDP's words for the closed set of reasons Hercle gives on a failed or expired order.
 * The transfer row carries them, so Hercle's own codes never reach a caller.
 */
const HERCLE_ORDER_ERRORS = {
  THIRD_PARTY_PAYER: "The wire came from an account other than the business's own.",
  FUNDING_WINDOW_EXPIRED: "The order's funding window closed before the wire arrived.",
  SETTLEMENT_FAILED: "Hercle could not settle the order.",
} as const satisfies Record<string, string>;

function isKnownHercleOrderError(error: string): error is keyof typeof HERCLE_ORDER_ERRORS {
  return Object.hasOwn(HERCLE_ORDER_ERRORS, error);
}

const HERCLE_DEFAULT_ORDER_ERRORS = {
  failed: "Hercle failed the order.",
  expired: "The order expired before it was funded.",
} as const satisfies Record<"failed" | "expired", string>;

/**
 * The fields SDP reads from a Hercle on-ramp order, mapped once for the webhook and the status lookup.
 * A `ramp.settlement.status_changed` webhook names the order id `reference`; a status lookup names it `orderId`.
 * `status` stays an open string so a status Hercle ships later maps to an ignore event.
 * The webhook's `receivedAmount` is the order's fiat, not the crypto delivered, so neither path reads an amount.
 * `txHash` is the transaction that delivered a settled order to `destinationWalletAddress`.
 */
export const hercleOrderStatusSchema = z.object({
  orderId: z.string().trim().min(1),
  status: z.string().trim().min(1),
  error: z.string().trim().min(1).nullish(),
  txHash: z.string().trim().min(1).nullish(),
  destinationWalletAddress: z.string().trim().min(1).nullish(),
});
export type HercleOrderStatus = z.output<typeof hercleOrderStatusSchema>;

/** The delivery a settled order reports, for SDP to verify on chain; none while Hercle names no transaction. */
function hercleDelivery(order: HercleOrderStatus): RampOnchainTransfer | undefined {
  if (order.txHash === null || order.txHash === undefined) {
    return undefined;
  }
  return order.destinationWalletAddress === null || order.destinationWalletAddress === undefined
    ? { signature: order.txHash }
    : { signature: order.txHash, destinationAddress: order.destinationWalletAddress };
}

/**
 * Maps a Hercle order to the settlement event its webhook produces.
 * Hercle reports no per-order observation time.
 * A settled order names its delivery's `txHash`, and the transfer completes once the delivery verifier finds it on chain.
 * One that names none waits at `settling`.
 *
 * @param order - The order a webhook carried or a status lookup returned.
 * @returns The settlement event, or an ignore event for a status SDP does not track.
 */
export function hercleOrderSettlementEvent(order: HercleOrderStatus): RampSettlementEvent {
  if (!isTrackedHercleOrderStatus(order.status)) {
    return {
      provider: "hercle",
      kind: "ignore",
      reason: `unsupported_status:${order.status}`,
      unmappedStatus: order.status,
    };
  }
  const kind = HERCLE_ORDER_STATUS[order.status];
  const reference = order.orderId;
  switch (kind) {
    case "awaiting_payment":
    case "settling":
      return { provider: "hercle", kind, reference };
    case "settled": {
      const onchain = hercleDelivery(order);
      return onchain === undefined
        ? { provider: "hercle", kind, reference }
        : { provider: "hercle", kind, reference, onchain };
    }
    case "failed":
    case "expired": {
      const error =
        order.error !== null && order.error !== undefined && isKnownHercleOrderError(order.error)
          ? HERCLE_ORDER_ERRORS[order.error]
          : HERCLE_DEFAULT_ORDER_ERRORS[kind];
      return { provider: "hercle", kind, reference, error };
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled Hercle order status kind: ${String(exhaustive)}`);
    }
  }
}
