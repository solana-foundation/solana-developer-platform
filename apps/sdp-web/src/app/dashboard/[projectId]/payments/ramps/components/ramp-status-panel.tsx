"use client";

import type { PaymentTransferSummary, RampDirection } from "@sdp/types/payments";
import { cn } from "@sdp/ui/cn";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sdp/ui/tooltip";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  InfoIcon,
  Loader2Icon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";
import {
  type RampPhaseCopy,
  type RampPhaseTone,
  rampPhaseCopy,
} from "@/app/dashboard/[projectId]/payments/ramps/ramp-phase";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import type { TranslationValues } from "@/i18n/translate";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/** The transfer's phase in words, or the preparing copy before the first poll answers. */
function statusCopy(
  t: Translate,
  direction: RampDirection,
  transfer: PaymentTransferSummary | null | undefined,
  hosted: boolean,
  locale: string
): Pick<RampPhaseCopy, "title" | "description" | "tone"> {
  if (!transfer) {
    return {
      title: t("DashboardPayments.ramps.status.preparing"),
      description: t("DashboardPayments.ramps.status.preparingDescription"),
      tone: "progress",
    };
  }
  return rampPhaseCopy(t, { ...transfer, type: direction }, { hosted, locale });
}

function statusIcon(tone: RampPhaseTone, sizeClassName = "size-5") {
  switch (tone) {
    case "success":
      return <CheckCircle2Icon className={cn(sizeClassName, "text-success")} />;
    case "error":
      return <XCircleIcon className={cn(sizeClassName, "text-error")} />;
    case "attention":
      return <TriangleAlertIcon className={cn(sizeClassName, "text-warning")} />;
    // The next move is the customer's, so nothing spins while they decide.
    case "action":
      return <CircleDotIcon className={cn(sizeClassName, "text-secondary")} />;
    case "progress":
      return <Loader2Icon className={cn(sizeClassName, "animate-spin text-secondary")} />;
    default: {
      const exhaustive: never = tone;
      throw new Error(`Unhandled transfer status tone: ${exhaustive}`);
    }
  }
}

/**
 * Compact one-line status for the wizard title row: icon and title only, the
 * subtle sibling of RampStatusPanel for stages where the provider window is
 * the hero.
 *
 * @param props - Direction, the polled transfer, and the hosted-copy flag.
 * @returns The inline status, or null before the first poll result.
 */
export function RampStatusInline({
  direction,
  transfer,
  hosted = false,
}: {
  direction: RampDirection;
  transfer: PaymentTransferSummary | null | undefined;
  /** The customer pays inside an embedded provider window, not via copied instructions. */
  hosted?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const copy = statusCopy(t, direction, transfer, hosted, locale);
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-fill-subtle px-3 py-1.5 text-sm font-medium text-secondary">
      {statusIcon(copy.tone, "size-4")}
      {copy.title}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label={copy.description} className="flex items-center">
              <InfoIcon className="size-3.5 text-muted" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{copy.description}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}

export function RampStatusPanel({
  direction,
  transfer,
  hosted = false,
}: {
  direction: RampDirection;
  transfer: PaymentTransferSummary | null | undefined;
  /** The customer pays inside an embedded provider window, not via copied instructions. */
  hosted?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const copy = statusCopy(t, direction, transfer, hosted, locale);
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0">{statusIcon(copy.tone)}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-primary">{copy.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-tertiary">{copy.description}</p>
      </div>
    </div>
  );
}
