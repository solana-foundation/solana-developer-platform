"use client";

/**
 * What to do about this trade, right now.
 *
 * The status badge says what state the trade is in; it does not say whose move
 * it is. Those are different questions, and "partially funded" in particular
 * answers neither on its own: it means the same word whether you are the one
 * still owing a leg or the one waiting on someone else.
 *
 * Every line here is derived from the last on-chain reading, so it inherits
 * that reading's age. The program emits no events, which is why the panel says
 * what was observed rather than what is true.
 */

import { ClockIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { custodiedSidesOf, type DvpTrade, isDvpPartyView } from "./dvp-trade";

type Tone = "info" | "waiting" | "attention";

const TONE_STYLES: Record<Tone, { box: string; icon: string }> = {
  info: { box: "border-border-default bg-surface-raised", icon: "text-tertiary" },
  waiting: { box: "border-border-default bg-surface-raised", icon: "text-tertiary" },
  attention: { box: "border-warning-border bg-warning-bg", icon: "text-warning" },
};

/**
 * One mark per meaning, and the same mark this page already uses for it.
 *
 * Waiting was an hourglass here and a clock on the leg card directly below —
 * two different marks for one idea, on one screen. The hourglass was also the
 * odd one optically: its glyph is drawn narrow inside the same 16px box the
 * circle and triangle fill, so it sat in a pocket of empty space and read as
 * misplaced rather than as small.
 */
const TONE_ICONS: Record<Tone, typeof InfoIcon> = {
  info: InfoIcon,
  waiting: ClockIcon,
  attention: TriangleAlertIcon,
};

function Panel({ children, tone, title }: { children: ReactNode; tone: Tone; title: string }) {
  const Icon = TONE_ICONS[tone];
  return (
    <section className={cn("flex gap-3 rounded-2xl border p-4", TONE_STYLES[tone].box)}>
      <Icon aria-hidden className={cn("mt-0.5 h-4 w-4 shrink-0", TONE_STYLES[tone].icon)} />
      <div className="min-w-0">
        <h2 className="font-medium text-primary text-sm">{title}</h2>
        <p className="mt-1 text-secondary text-xs leading-relaxed">{children}</p>
      </div>
    </section>
  );
}

/** Whether the caller's every custodied leg already holds its target. */
function ownLegsFunded(trade: DvpTrade): boolean {
  return custodiedSidesOf(trade).every((side) => trade.legs[side].funding?.funded === true);
}

/**
 * Whose move it is for a party reading a trade somebody else created.
 *
 * Only two answers are ever theirs: fund your leg, or wait. Settling belongs to
 * the organization that set the trade up, so even a fully funded trade asks
 * nothing of them.
 */
function partyNextStep(
  trade: DvpTrade,
  t: ReturnType<typeof useTranslations>
): { tone: Tone; title: string; body: string } | null {
  const yours = trade.yourSide === "a" ? trade.legs.a : trade.legs.b;

  switch (trade.status) {
    case "created":
    case "partially_funded":
      return yours.funding?.funded
        ? {
            tone: "waiting",
            title: t("DashboardMarkets.dvp.nextPartyAwaitTitle"),
            body: t("DashboardMarkets.dvp.nextPartyAwaitBody"),
          }
        : {
            tone: "info",
            title: t("DashboardMarkets.dvp.nextPartyFundTitle"),
            body: t("DashboardMarkets.dvp.nextPartyFundBody"),
          };
    case "funded":
      return {
        tone: "waiting",
        title: t("DashboardMarkets.dvp.nextPartySettleTitle"),
        body: t("DashboardMarkets.dvp.nextPartySettleBody"),
      };
    case "expired":
      return {
        tone: "attention",
        title: t("DashboardMarkets.dvp.nextExpiredTitle"),
        body: t("DashboardMarkets.dvp.nextExpiredBody"),
      };
    default:
      return null;
  }
}

/**
 * Whose move it is on a trade this organization is not a party to.
 *
 * Nothing here is ever this operator's move until both escrows are funded: the
 * two parties pay their own, and settling is the only thing an agent does.
 */
function agentNextStep(
  trade: DvpTrade,
  t: ReturnType<typeof useTranslations>
): { tone: Tone; title: string; body: string } | null {
  switch (trade.status) {
    case "creating":
      return {
        tone: "waiting",
        title: t("DashboardMarkets.dvp.nextCreatingTitle"),
        body: t("DashboardMarkets.dvp.nextCreatingBody"),
      };
    case "created":
    case "partially_funded": {
      const paid = [trade.legs.a, trade.legs.b].filter((leg) => leg.funding?.funded).length;
      return {
        tone: "waiting",
        title: t(
          paid === 1
            ? "DashboardMarkets.dvp.nextAgentOneLeftTitle"
            : "DashboardMarkets.dvp.nextAgentFundTitle"
        ),
        body: t(
          paid === 1
            ? "DashboardMarkets.dvp.nextAgentOneLeftBody"
            : "DashboardMarkets.dvp.nextAgentFundBody"
        ),
      };
    }
    case "funded":
      return {
        tone: "info",
        title: t("DashboardMarkets.dvp.nextAgentSettleTitle"),
        body: t("DashboardMarkets.dvp.nextAgentSettleBody"),
      };
    case "expired":
      return {
        tone: "attention",
        title: t("DashboardMarkets.dvp.nextExpiredTitle"),
        body: t("DashboardMarkets.dvp.nextExpiredBody"),
      };
    case "create_failed":
      return {
        tone: "attention",
        title: t("DashboardMarkets.dvp.nextCreateFailedTitle"),
        body: t("DashboardMarkets.dvp.nextCreateFailedBody"),
      };
    default:
      return null;
  }
}

/**
 * The caller holds both legs of one of its own trades.
 *
 * There is no counterparty to wait on: fund the outstanding leg or legs, then
 * settle. Once both hold their target the ordinary settle copy applies.
 */
function bilateralNextStep(
  trade: DvpTrade,
  t: ReturnType<typeof useTranslations>
): { tone: Tone; title: string; body: string } | null {
  switch (trade.status) {
    case "creating":
      return {
        tone: "waiting",
        title: t("DashboardMarkets.dvp.nextCreatingTitle"),
        body: t("DashboardMarkets.dvp.nextCreatingBody"),
      };
    case "created":
    case "partially_funded":
      return ownLegsFunded(trade)
        ? {
            tone: "waiting",
            title: t("DashboardMarkets.dvp.nextPartySettleTitle"),
            body: t("DashboardMarkets.dvp.nextPartySettleBody"),
          }
        : {
            tone: "info",
            title: t("DashboardMarkets.dvp.nextBilateralFundTitle"),
            body: t("DashboardMarkets.dvp.nextBilateralFundBody"),
          };
    case "funded":
      return {
        tone: "info",
        title: t("DashboardMarkets.dvp.nextSettleTitle"),
        body: t("DashboardMarkets.dvp.nextSettleBody"),
      };
    case "expired":
      return {
        tone: "attention",
        title: t("DashboardMarkets.dvp.nextExpiredTitle"),
        body: t("DashboardMarkets.dvp.nextExpiredBody"),
      };
    case "create_failed":
      return {
        tone: "attention",
        title: t("DashboardMarkets.dvp.nextCreateFailedTitle"),
        body: t("DashboardMarkets.dvp.nextCreateFailedBody"),
      };
    default:
      return null;
  }
}

/**
 * Whose move it is on a principal trade this organization created.
 *
 * The custodied side is the caller's leg; the other side is the counterparty.
 * Frozen and over-funded escrows have their own callouts on this page, so they
 * are deliberately not repeated here. This panel answers one question those do
 * not: whose move is it.
 */
function principalNextStep(
  trade: DvpTrade,
  t: ReturnType<typeof useTranslations>
): { tone: Tone; title: string; body: string } | null {
  // The API derived `kind` from the same custody lookup as `custodied`, so a
  // principal trade has exactly one custodied side. Falling back to leg A is
  // unreachable; the switch below is exhaustive over what the wire promises.
  const side = custodiedSidesOf(trade)[0] ?? "a";
  const sdpLeg = trade.legs[side];
  const otherLeg = trade.legs[side === "a" ? "b" : "a"];

  switch (trade.status) {
    case "creating":
      return {
        tone: "waiting",
        title: t("DashboardMarkets.dvp.nextCreatingTitle"),
        body: t("DashboardMarkets.dvp.nextCreatingBody"),
      };
    case "created":
    case "partially_funded": {
      // "Partially funded" is not one situation. Which leg is outstanding
      // decides whether there is anything for this operator to do at all.
      const weOwe = !sdpLeg.funding?.funded;
      const theyOwe = !otherLeg.funding?.funded;
      if (weOwe) {
        return {
          tone: "info",
          title: t("DashboardMarkets.dvp.nextFundYoursTitle"),
          body: theyOwe
            ? t("DashboardMarkets.dvp.nextFundYoursBothBody")
            : t("DashboardMarkets.dvp.nextFundYoursOnlyBody"),
        };
      }
      return {
        tone: "waiting",
        title: t("DashboardMarkets.dvp.nextAwaitThemTitle"),
        body: t("DashboardMarkets.dvp.nextAwaitThemBody"),
      };
    }
    case "funded":
      return {
        tone: "info",
        title: t("DashboardMarkets.dvp.nextSettleTitle"),
        body: t("DashboardMarkets.dvp.nextSettleBody"),
      };
    case "expired":
      return {
        tone: "attention",
        title: t("DashboardMarkets.dvp.nextExpiredTitle"),
        body: t("DashboardMarkets.dvp.nextExpiredBody"),
      };
    case "create_failed":
      return {
        tone: "attention",
        title: t("DashboardMarkets.dvp.nextCreateFailedTitle"),
        body: t("DashboardMarkets.dvp.nextCreateFailedBody"),
      };
    // Settled, cancelled, rejected and closed_unknown are over. The status
    // badge already says so, and inventing a "next step" for a closed trade
    // would be worse than saying nothing.
    default:
      return null;
  }
}

/** Whose move it is, in one sentence, for the state the trade is actually in. */
function nextStep(
  trade: DvpTrade,
  t: ReturnType<typeof useTranslations>
): { tone: Tone; title: string; body: string } | null {
  // A party reading somebody else's trade holds exactly one leg and cannot
  // close the trade. Checked BEFORE the kind branches: the same trade is an
  // agent trade to its author and a leg you owe to the party named on it, and
  // telling the party they hold neither leg is simply false.
  if (isDvpPartyView(trade)) {
    return partyNextStep(trade, t);
  }

  switch (trade.kind) {
    case "bilateral":
      return bilateralNextStep(trade, t);
    case "agent":
      return agentNextStep(trade, t);
    case "principal":
      return principalNextStep(trade, t);
  }
}

export function DvpNextStep({ trade }: { trade: DvpTrade }) {
  const t = useTranslations();
  const step = nextStep(trade, t);
  if (!step) {
    return null;
  }
  return (
    <Panel title={step.title} tone={step.tone}>
      {step.body}
    </Panel>
  );
}
