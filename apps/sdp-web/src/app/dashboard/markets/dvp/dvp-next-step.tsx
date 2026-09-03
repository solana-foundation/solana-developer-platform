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
import type { DvpTrade } from "./dvp-trade";

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

/** Whose move it is, in one sentence, for the state the trade is actually in. */
function nextStep(
  trade: DvpTrade,
  t: ReturnType<typeof useTranslations>
): { tone: Tone; title: string; body: string } | null {
  const sdpLeg = trade.sdpSide === "a" ? trade.legs.a : trade.legs.b;
  const otherLeg = trade.sdpSide === "a" ? trade.legs.b : trade.legs.a;

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
