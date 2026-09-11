"use client";

/**
 * Settling, cancelling and funding a leg of a trade.
 *
 * Pulled out of the detail page so the page reads as layout. All four
 * operations go through one request shape and share success and failure handling.
 *
 * Funding is the one action that names a leg: the unified fund endpoint takes
 * `{ side: "a" | "b" }`, authorizing by the caller holding custody of that
 * side's party address — whoever holds it, on whichever org's trade.
 */

import type { DvpTradeSide } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";

export type DvpTradeActionName = "settle" | "cancel" | "fund";

/** Settle and cancel act on the trade; fund names the leg it moves. */
export type DvpTradeActionCall =
  | [action: "settle" | "cancel"]
  | [action: "fund", options: { side: DvpTradeSide }];

/**
 * One in-flight request. Funding is keyed by side, since a bilateral trade
 * funds two legs from two wallets and waiting on one must not block the other.
 */
export type DvpPendingAction = "settle" | "cancel" | `fund:${DvpTradeSide}`;

export interface DvpTradeActions {
  act: (...call: DvpTradeActionCall) => Promise<void>;
  pending: ReadonlySet<DvpPendingAction>;
}

/**
 * What to say when an action lands, keyed by the action.
 *
 * The confirmation uses the same verb as the button that caused it — "Settle"
 * produces "Trade settled" — so the vocabulary somebody learns from the control
 * is the vocabulary the product answers in.
 */
const DONE_MESSAGE: Record<DvpTradeActionName, MessageKey> = {
  settle: "DashboardMarkets.dvp.toastSettled",
  cancel: "DashboardMarkets.dvp.toastCancelled",
  fund: "DashboardMarkets.dvp.toastFunded",
};

export function useDvpTradeActions(tradeId: string): DvpTradeActions {
  const router = useRouter();
  const t = useTranslations();
  const [pending, setPending] = useState<ReadonlySet<DvpPendingAction>>(new Set());

  async function act(...call: DvpTradeActionCall) {
    const [action] = call;
    const key: DvpPendingAction = call[0] === "fund" ? `fund:${call[1].side}` : call[0];
    setPending((current) => new Set(current).add(key));
    try {
      const response = await fetch(
        `/api/dashboard/markets/dvp/trades/${encodeURIComponent(tradeId)}/${action}`,
        {
          method: "POST",
          // Funding names the leg it moves; settle and cancel carry no body.
          ...(call[0] === "fund" ? { body: JSON.stringify({ side: call[1].side }) } : {}),
        }
      );
      if (!response.ok) {
        const body = (await response.json()) as {
          error?: { message?: string; details?: { reason?: string } };
        };
        let message = `Request failed (${response.status}).`;
        if (body.error?.message !== undefined) {
          message = body.error.message;
        }
        if (body.error?.details?.reason !== undefined) {
          message = body.error.details.reason;
        }
        toast.error(message, { position: "bottom-right" });
        return;
      }
      // The single biggest source of "did anything happen?": all three of these
      // succeeded and then said nothing, leaving the page to catch up on the
      // reconciler's next sweep. A refresh is not an answer — it is the same
      // screen again, a minute later.
      toast.success(t(DONE_MESSAGE[action]), { position: "bottom-right" });
      router.refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Request failed.";
      toast.error(message, { position: "bottom-right" });
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  return { act, pending };
}
