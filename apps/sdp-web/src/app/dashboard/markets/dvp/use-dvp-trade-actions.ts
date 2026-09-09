"use client";

/**
 * Settling, cancelling and funding a leg of a trade.
 *
 * Pulled out of the detail page so the page reads as layout. All four
 * operations go through one request shape, and all three outcomes that are
 * easy to conflate are shared: done, held for approval, and failed.
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

/** Funding options: the leg being funded is part of the request. */
export interface DvpTradeActionOptions {
  side?: DvpTradeSide;
}

export interface DvpTradeActions {
  act: (action: DvpTradeActionName, options?: DvpTradeActionOptions) => Promise<void>;
  awaitingApproval: boolean;
  error: string | null;
  pending: DvpTradeActionName | null;
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

const HELD_MESSAGE: Record<DvpTradeActionName, MessageKey> = {
  settle: "DashboardMarkets.dvp.toastSettleHeld",
  cancel: "DashboardMarkets.dvp.toastCancelHeld",
  fund: "DashboardMarkets.dvp.toastFundHeld",
};

export function useDvpTradeActions(tradeId: string): DvpTradeActions {
  const router = useRouter();
  const t = useTranslations();
  const [pending, setPending] = useState<DvpTradeActionName | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: DvpTradeActionName, options?: DvpTradeActionOptions) {
    setPending(action);
    setError(null);
    setAwaitingApproval(false);
    try {
      const response = await fetch(
        `/api/dashboard/markets/dvp/trades/${encodeURIComponent(tradeId)}/${action}`,
        {
          method: "POST",
          // Funding names the leg it moves; settle and cancel carry no body.
          ...(action === "fund" && options?.side
            ? { body: JSON.stringify({ side: options.side }) }
            : {}),
        }
      );
      // 202 is a normal outcome, not a failure: wallet policy is holding the
      // action for approval. Treating it as an error would tell an operator
      // something broke when the platform did exactly what they configured.
      if (response.status === 202) {
        setAwaitingApproval(true);
        toast.success(t(HELD_MESSAGE[action]), { position: "bottom-right" });
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string; details?: { reason?: string } };
        };
        // The specific reason first. Policy answers "denied by policy" as its
        // headline and puts WHY in the details — which rule matched and on what
        // — and showing only the headline left an operator with a red line and
        // nowhere to go. "Destination <escrow> is not allowed by policy" names
        // the rule to change; "denied by policy" names nothing.
        setError(
          body.error?.details?.reason ??
            body.error?.message ??
            `Request failed (${response.status}).`
        );
        return;
      }
      // The single biggest source of "did anything happen?": all three of these
      // succeeded and then said nothing, leaving the page to catch up on the
      // reconciler's next sweep. A refresh is not an answer — it is the same
      // screen again, a minute later.
      toast.success(t(DONE_MESSAGE[action]), { position: "bottom-right" });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setPending(null);
    }
  }

  return { act, awaitingApproval, error, pending };
}
