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

import {
  DVP_FUND_REFUSAL,
  type DvpFundRefusalReason,
  type DvpTradeSide,
  type SolanaCluster,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";

export type DvpTradeActionName = "settle" | "cancel" | "fund";

/**
 * Settle and cancel act on the trade; fund names the leg it moves, and that
 * leg's symbol so a refusal can name the token instead of its mint.
 */
export type DvpTradeActionCall =
  | [action: "settle" | "cancel"]
  | [action: "fund", options: { side: DvpTradeSide; symbol: string | null }];

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

/**
 * The copy for each fund refusal. The API's message names trade ids, wallet
 * addresses and mints, which is right for a log and wrong for a toast.
 *
 * The chain-verification refusals share one line: to the person funding, a
 * trade that re-reads differently, an escrow that is missing and a mint that
 * cannot be read are the same answer — nothing moved, and it is not theirs to fix.
 */
const FUND_REFUSAL_MESSAGE: Record<
  DvpFundRefusalReason,
  { withSymbol: MessageKey; withoutSymbol: MessageKey }
> = {
  [DVP_FUND_REFUSAL.walletHoldsNoToken]: {
    withSymbol: "DashboardMarkets.dvp.fundRefusedNoToken",
    withoutSymbol: "DashboardMarkets.dvp.fundRefusedNoTokenUnnamed",
  },
  [DVP_FUND_REFUSAL.walletBalanceShort]: {
    withSymbol: "DashboardMarkets.dvp.fundRefusedBalanceShort",
    withoutSymbol: "DashboardMarkets.dvp.fundRefusedBalanceShortUnnamed",
  },
  [DVP_FUND_REFUSAL.legAlreadyFunded]: sameCopy("DashboardMarkets.dvp.fundRefusedAlreadyFunded"),
  [DVP_FUND_REFUSAL.legFundingInProgress]: sameCopy("DashboardMarkets.dvp.fundRefusedInProgress"),
  [DVP_FUND_REFUSAL.escrowBalanceChanged]: sameCopy(
    "DashboardMarkets.dvp.fundRefusedBalanceChanged"
  ),
  [DVP_FUND_REFUSAL.escrowFrozen]: sameCopy("DashboardMarkets.dvp.fundRefusedFrozen"),
  [DVP_FUND_REFUSAL.tradeNotFundable]: sameCopy("DashboardMarkets.dvp.fundRefusedNotFundable"),
  [DVP_FUND_REFUSAL.termsMismatch]: sameCopy("DashboardMarkets.dvp.fundRefusedUnverified"),
  [DVP_FUND_REFUSAL.tradeNotOnChain]: sameCopy("DashboardMarkets.dvp.fundRefusedUnverified"),
  [DVP_FUND_REFUSAL.escrowMissing]: sameCopy("DashboardMarkets.dvp.fundRefusedUnverified"),
  [DVP_FUND_REFUSAL.escrowMismatch]: sameCopy("DashboardMarkets.dvp.fundRefusedUnverified"),
  [DVP_FUND_REFUSAL.mintUnreadable]: sameCopy("DashboardMarkets.dvp.fundRefusedUnverified"),
};

function sameCopy(key: MessageKey): { withSymbol: MessageKey; withoutSymbol: MessageKey } {
  return { withSymbol: key, withoutSymbol: key };
}

const fundRefusalReasonSchema = z.enum(DVP_FUND_REFUSAL);

/** A failed call's envelope. Only what the toast reads is required. */
const errorEnvelopeSchema = z.object({
  error: z.object({
    message: z.string(),
    details: z.object({ reason: z.string() }).partial().optional(),
  }),
});

/** Settle, cancel and fund all answer with the transaction they broadcast. */
const broadcastEnvelopeSchema = z.object({ data: z.object({ signature: z.string() }) });

export function useDvpTradeActions(tradeId: string, cluster: SolanaCluster): DvpTradeActions {
  const router = useRouter();
  const t = useTranslations();
  const [pending, setPending] = useState<ReadonlySet<DvpPendingAction>>(new Set());

  /** Plain copy for a refusal the dashboard can name, else the API's own message. */
  function refusalMessage(body: unknown, status: number, symbol: string | null): string {
    const envelope = errorEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      return t("DashboardMarkets.dvp.actionFailed", { status: String(status) });
    }
    const reason = fundRefusalReasonSchema.safeParse(envelope.data.error.details?.reason);
    if (!reason.success) {
      return envelope.data.error.message;
    }
    const copy = FUND_REFUSAL_MESSAGE[reason.data];
    return symbol === null ? t(copy.withoutSymbol) : t(copy.withSymbol, { symbol });
  }

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
      // Null when the body is not JSON at all, such as a proxy's error page. Both
      // schemas below then fail, which is handled as a failure, not a success.
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const symbol = call[0] === "fund" ? call[1].symbol : null;
        toast.error(refusalMessage(body, response.status, symbol), { position: "bottom-right" });
        return;
      }
      // The single biggest source of "did anything happen?": all three of these
      // succeeded and then said nothing, leaving the page to catch up on the
      // reconciler's next sweep. A refresh is not an answer — it is the same
      // screen again, a minute later.
      const broadcast = broadcastEnvelopeSchema.safeParse(body);
      toast.success(t(DONE_MESSAGE[action]), {
        position: "bottom-right",
        // Whatever SDP just sent can be checked on chain from the toast that
        // reports it, without hunting for it on the page.
        action: broadcast.success
          ? {
              label: t("DashboardMarkets.dvp.viewTransaction"),
              onClick: () =>
                window.open(
                  explorerTxUrl(broadcast.data.data.signature, cluster),
                  "_blank",
                  "noopener,noreferrer"
                ),
            }
          : undefined,
      });
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
