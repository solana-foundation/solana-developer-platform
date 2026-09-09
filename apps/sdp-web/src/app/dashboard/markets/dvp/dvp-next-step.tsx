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
import { type DvpTrade, isDvpAgentTrade, isDvpPartyView } from "./dvp-trade";

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
 * two parties pay their own, and settling is the only thing an agent does. The
 * principal version of this panel asks "do we still owe a leg", which on an
 * agent trade has no answer, and answered it "yes" anyway.
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

/** Whose move it is, in one sentence, for the state the trade is actually in. */
function nextStep(
  trade: DvpTrade,
  t: ReturnType<typeof useTranslations>
): { tone: Tone; title: string; body: string } | null {
  // A party reading somebody else's trade holds exactly one leg and cannot
  // close the trade. Checked BEFORE the agent branch: the same trade is an
  // agent trade to its author and a leg you owe to the party named on it, and
  // telling the party they hold neither leg is simply false.
  if (isDvpPartyView(trade)) {
    return partyNextStep(trade, t);
  }

  // On an agent trade there is no "ours" and no "theirs", so the question this
  // panel answers changes: not whose move it is between us and a counterparty,
  // but how many of the two parties have paid.
  if (isDvpAgentTrade(trade)) {
    return agentNextStep(trade, t);
  }

  // Guarded above, so a side exists here. Compared explicitly against "b"
  // rather than falling through an "a" check, because that else branch is what
  // silently claimed leg B on a trade with no SDP leg at all.
  const sdpLeg = trade.sdpSide === "b" ? trade.legs.b : trade.legs.a;
  const otherLeg = trade.sdpSide === "b" ? trade.legs.a : trade.legs.b;

  // Frozen and over-funded escrows have their own callouts on this page, so
  // they are deliberately not repeated here. This panel answers one question
  // those do not: whose move is it.
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
