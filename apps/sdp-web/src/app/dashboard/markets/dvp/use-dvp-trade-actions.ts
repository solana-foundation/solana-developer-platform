"use client";

/**
 * Settling, cancelling and funding a leg of a trade.
 *
 * Pulled out of the detail page so the page reads as layout. All four
 * operations go through one request shape and share success and failure handling.
 *
 * Funding and reclaiming name a leg: both endpoints take `{ side: "a" | "b" }`,
 * authorizing by the caller holding custody of that side's party address,
 * whoever holds it, on whichever org's trade. Each press of either carries its
 * own Idempotency-Key, so a request the proxy or network retries is answered
 * with the first result instead of moving the leg twice.
 */

import {
  DVP_CLOSE_REFUSAL,
  DVP_LEG_REFUSAL,
  type DvpCloseRefusalReason,
  type DvpLegRefusalReason,
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
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { freshDvpIdempotencyKey } from "./dvp-idempotency-key";

export type DvpTradeActionName = "settle" | "cancel" | "fund" | "reclaim";

/**
 * Settle and cancel act on the trade; fund and reclaim name the leg they move,
 * and that leg's symbol so a refusal can name the token instead of its mint.
 */
export type DvpTradeActionCall =
  | [action: "settle" | "cancel"]
  | [action: "fund" | "reclaim", options: { side: DvpTradeSide; symbol: string | null }];

/**
 * One in-flight request. Funding is keyed by side, since a bilateral trade
 * funds two legs from two wallets and waiting on one must not block the other.
 */
export type DvpPendingAction =
  | "settle"
  | "cancel"
  | `fund:${DvpTradeSide}`
  | `reclaim:${DvpTradeSide}`;

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
  reclaim: "DashboardMarkets.dvp.toastReclaimed",
};

/**
 * The copy for each fund refusal. The API's message names trade ids, wallet
 * addresses and mints, which is right for a log and wrong for a toast.
 *
 * The chain-verification refusals share one line: to the person funding, a
 * trade that re-reads differently, an escrow that is missing and a mint that
 * cannot be read are the same answer — nothing moved, and it is not theirs to fix.
 */
const LEG_REFUSAL_MESSAGE: Record<
  DvpLegRefusalReason,
  { withSymbol: MessageKey; withoutSymbol: MessageKey }
> = {
  [DVP_LEG_REFUSAL.walletHoldsNoToken]: {
    withSymbol: "DashboardMarkets.dvp.fundRefusedNoToken",
    withoutSymbol: "DashboardMarkets.dvp.fundRefusedNoTokenUnnamed",
  },
  [DVP_LEG_REFUSAL.walletBalanceShort]: {
    withSymbol: "DashboardMarkets.dvp.fundRefusedBalanceShort",
    withoutSymbol: "DashboardMarkets.dvp.fundRefusedBalanceShortUnnamed",
  },
  [DVP_LEG_REFUSAL.legAlreadyFunded]: sameCopy("DashboardMarkets.dvp.fundRefusedAlreadyFunded"),
  [DVP_LEG_REFUSAL.legFundingInProgress]: sameCopy("DashboardMarkets.dvp.fundRefusedInProgress"),
  [DVP_LEG_REFUSAL.escrowBalanceChanged]: sameCopy(
    "DashboardMarkets.dvp.fundRefusedBalanceChanged"
  ),
  [DVP_LEG_REFUSAL.escrowFrozen]: sameCopy("DashboardMarkets.dvp.fundRefusedFrozen"),
  [DVP_LEG_REFUSAL.tradeNotFundable]: sameCopy("DashboardMarkets.dvp.fundRefusedNotFundable"),
  [DVP_LEG_REFUSAL.termsMismatch]: sameCopy("DashboardMarkets.dvp.fundRefusedUnverified"),
  [DVP_LEG_REFUSAL.tradeNotOnChain]: sameCopy("DashboardMarkets.dvp.fundRefusedUnverified"),
  [DVP_LEG_REFUSAL.escrowMissing]: sameCopy("DashboardMarkets.dvp.fundRefusedUnverified"),
  [DVP_LEG_REFUSAL.escrowMismatch]: sameCopy("DashboardMarkets.dvp.fundRefusedUnverified"),
  [DVP_LEG_REFUSAL.mintUnreadable]: sameCopy("DashboardMarkets.dvp.fundRefusedUnverified"),
  [DVP_LEG_REFUSAL.tradeNotReclaimable]: sameCopy("DashboardMarkets.dvp.reclaimRefusedClosed"),
  [DVP_LEG_REFUSAL.nothingToReclaim]: sameCopy("DashboardMarkets.dvp.reclaimRefusedEmpty"),
  [DVP_LEG_REFUSAL.transferHookUnsupported]: sameCopy(
    "DashboardMarkets.dvp.reclaimRefusedTransferHook"
  ),
  [DVP_LEG_REFUSAL.signerNotParty]: sameCopy("DashboardMarkets.dvp.reclaimRefusedSignerChanged"),
  [DVP_LEG_REFUSAL.tradeClosing]: sameCopy("DashboardMarkets.dvp.legRefusedTradeClosing"),
};

/** The copy for each settle or cancel refusal. */
const CLOSE_REFUSAL_MESSAGE: Record<DvpCloseRefusalReason, MessageKey> = {
  [DVP_CLOSE_REFUSAL.closeInProgress]: "DashboardMarkets.dvp.closeRefusedInProgress",
  [DVP_CLOSE_REFUSAL.legMoving]: "DashboardMarkets.dvp.closeRefusedLegMoving",
  [DVP_CLOSE_REFUSAL.closeFailedOnChain]: "DashboardMarkets.dvp.closeRefusedFailedOnChain",
};

/**
 * A settle or cancel sent but not confirmed within the request, keyed by action.
 * The trade updates once the reconciler reads it, so the toast says sent, not done.
 */
const SENT_MESSAGE: Record<"settle" | "cancel", MessageKey> = {
  settle: "DashboardMarkets.dvp.toastSettleSent",
  cancel: "DashboardMarkets.dvp.toastCancelSent",
};

function sameCopy(key: MessageKey): { withSymbol: MessageKey; withoutSymbol: MessageKey } {
  return { withSymbol: key, withoutSymbol: key };
}

const legRefusalReasonSchema = z.enum(DVP_LEG_REFUSAL);
const closeRefusalReasonSchema = z.enum(DVP_CLOSE_REFUSAL);

/** A failed call's envelope. Only what the toast reads is required. */
const errorEnvelopeSchema = z.object({
  error: z.object({
    message: z.string(),
    details: z.object({ reason: z.string() }).partial().optional(),
  }),
});

/** Fund and reclaim answer with the transaction they broadcast. */
const broadcastEnvelopeSchema = z.object({ data: z.object({ signature: z.string().min(1) }) });

/** Settle and cancel also say whether the close is confirmed yet. */
const closeEnvelopeSchema = z.object({
  data: z.object({ signature: z.string().min(1), confirmed: z.boolean() }),
});

/**
 * One in-flight key per action, per leg for the two that move one leg, so a
 * bilateral trade can fund or reclaim both legs without one blocking the other.
 */
function pendingKey(call: DvpTradeActionCall): DvpPendingAction {
  if (call.length === 1) {
    return call[0];
  }
  return call[0] === "fund" ? `fund:${call[1].side}` : `reclaim:${call[1].side}`;
}

/**
 * Fund and reclaim name the leg they move and carry their own Idempotency-Key;
 * settle and cancel carry neither.
 */
function requestInit(action: DvpTradeActionName, leg: { side: DvpTradeSide } | null): RequestInit {
  if (leg === null) {
    return { method: "POST" };
  }
  return {
    method: "POST",
    body: JSON.stringify({ side: leg.side }),
    headers: { [IDEMPOTENCY_KEY_HEADER]: freshDvpIdempotencyKey(`dvp-${action}`) },
  };
}

/**
 * What a success answer says was sent and the copy that reports it, or null
 * when it cannot be read. Only a close can be sent without being confirmed yet;
 * a leg action is reported once it is on the wire.
 */
function successOf(
  action: DvpTradeActionName,
  body: unknown
): { signature: string; message: MessageKey } | null {
  if (action === "settle" || action === "cancel") {
    const close = closeEnvelopeSchema.safeParse(body);
    if (!close.success) {
      return null;
    }
    const { signature, confirmed } = close.data.data;
    return { signature, message: confirmed ? DONE_MESSAGE[action] : SENT_MESSAGE[action] };
  }
  const broadcast = broadcastEnvelopeSchema.safeParse(body);
  return broadcast.success
    ? { signature: broadcast.data.data.signature, message: DONE_MESSAGE[action] }
    : null;
}

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
    const reasonCode = envelope.data.error.details?.reason;
    const legReason = legRefusalReasonSchema.safeParse(reasonCode);
    if (legReason.success) {
      const copy = LEG_REFUSAL_MESSAGE[legReason.data];
      return symbol === null ? t(copy.withoutSymbol) : t(copy.withSymbol, { symbol });
    }
    const closeReason = closeRefusalReasonSchema.safeParse(reasonCode);
    if (closeReason.success) {
      return t(CLOSE_REFUSAL_MESSAGE[closeReason.data]);
    }
    return envelope.data.error.message;
  }

  async function act(...call: DvpTradeActionCall) {
    const [action] = call;
    const key = pendingKey(call);
    const leg = call.length === 1 ? null : call[1];
    setPending((current) => new Set(current).add(key));
    try {
      const response = await fetch(
        `/api/dashboard/markets/dvp/trades/${encodeURIComponent(tradeId)}/${action}`,
        requestInit(action, leg)
      );
      // Either way the body can fail to be JSON at all, such as a proxy's error
      // page. It reads as null, and each schema below treats null as not matching.
      if (!response.ok) {
        const symbol = leg === null ? null : leg.symbol;
        const failure: unknown = await response.json().catch(() => null);
        toast.error(refusalMessage(failure, response.status, symbol), {
          position: "bottom-right",
        });
        return;
      }
      // A success answer that cannot be read is not a success to report: nothing
      // on it says what was sent. Say so, and let the refresh show what the
      // chain now holds instead of guessing.
      const body: unknown = await response.json().catch(() => null);
      const success = successOf(action, body);
      if (success === null) {
        toast.error(t("DashboardMarkets.dvp.actionUnconfirmed"), { position: "bottom-right" });
        router.refresh();
        return;
      }
      // The single biggest source of "did anything happen?": these used to
      // succeed and then say nothing, leaving the page to catch up on the
      // reconciler's next sweep. A refresh is not an answer. A close that went
      // out but has not confirmed says sent, not done.
      toast.success(t(success.message), {
        position: "bottom-right",
        // Whatever SDP just sent can be checked on chain from the toast that
        // reports it, without hunting for it on the page.
        action: {
          label: t("DashboardMarkets.dvp.viewTransaction"),
          onClick: () =>
            window.open(explorerTxUrl(success.signature, cluster), "_blank", "noopener,noreferrer"),
        },
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
