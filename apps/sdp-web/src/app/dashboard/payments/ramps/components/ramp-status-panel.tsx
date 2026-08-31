"use client";

import type { PaymentTransferSummary } from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import { CheckCircle2Icon, InfoIcon, Loader2Icon, XCircleIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

interface TransferStatusCopy {
  title: string;
  description: string;
  state: "loading" | "success" | "error";
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;

function transferStatusCopy(
  t: Translate,
  direction: RampDirection,
  status: string,
  hosted: boolean
): TransferStatusCopy {
  const onramp = direction === "onramp";
  switch (status) {
    case "pending":
    case "awaiting_payment":
      if (hosted) {
        return {
          title: t("DashboardPayments.ramps.status.waitingForPayment"),
          description: t("DashboardPayments.ramps.status.waitingForPaymentHostedDescription"),
          state: "loading",
        };
      }
      return {
        title: onramp
          ? t("DashboardPayments.ramps.status.waitingForFunding")
          : t("DashboardPayments.ramps.status.waitingToSend"),
        description: onramp
          ? t("DashboardPayments.ramps.status.waitingForFundingDescription")
          : t("DashboardPayments.ramps.status.waitingToSendDescription"),
        state: "loading",
      };
    case "processing":
    case "settling":
      return {
        title: onramp
          ? t("DashboardPayments.ramps.status.depositReceived")
          : t("DashboardPayments.ramps.status.sendingPayout"),
        description: onramp
          ? t("DashboardPayments.ramps.status.depositReceivedDescription")
          : t("DashboardPayments.ramps.status.sendingPayoutDescription"),
        state: "loading",
      };
    case "completed":
      return {
        title: onramp
          ? t("DashboardPayments.ramps.status.transferComplete")
          : t("DashboardPayments.ramps.status.payoutSent"),
        description: onramp
          ? t("DashboardPayments.ramps.status.transferCompleteDescription")
          : t("DashboardPayments.ramps.status.payoutSentDescription"),
        state: "success",
      };
    case "failed":
      return {
        title: onramp
          ? t("DashboardPayments.ramps.status.transferFailed")
          : t("DashboardPayments.ramps.status.payoutFailed"),
        description: onramp
          ? t("DashboardPayments.ramps.status.transferFailedDescription")
          : t("DashboardPayments.ramps.status.payoutFailedDescription"),
        state: "error",
      };
    case "expired":
      return {
        title: t("DashboardPayments.ramps.status.quoteExpired"),
        description: onramp
          ? t("DashboardPayments.ramps.status.quoteExpiredFundingDescription")
          : t("DashboardPayments.ramps.status.quoteExpiredPayoutDescription"),
        state: "error",
      };
    case "canceled":
      return {
        title: t("DashboardPayments.ramps.status.updated"),
        description: t("DashboardPayments.ramps.status.currentProviderStatus", { status }),
        state: "error",
      };
    default:
      return {
        title: t("DashboardPayments.ramps.status.updated"),
        description: t("DashboardPayments.ramps.status.currentProviderStatus", { status }),
        state: "loading",
      };
  }
}

function statusIcon(state: TransferStatusCopy["state"], sizeClassName = "size-5") {
  switch (state) {
    case "success":
      return <CheckCircle2Icon className={cn(sizeClassName, "text-success")} />;
    case "error":
      return <XCircleIcon className={cn(sizeClassName, "text-error")} />;
    case "loading":
      return <Loader2Icon className={cn(sizeClassName, "animate-spin text-secondary")} />;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled transfer status state: ${exhaustive}`);
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
  const copy: TransferStatusCopy = transfer
    ? transferStatusCopy(t, direction, transfer.status, hosted)
    : {
        title: t("DashboardPayments.ramps.status.preparing"),
        description: t("DashboardPayments.ramps.status.preparingDescription"),
        state: "loading",
      };
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-fill-subtle px-3 py-1.5 text-sm font-medium text-secondary">
      {statusIcon(copy.state, "size-4")}
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
  const copy: TransferStatusCopy = transfer
    ? transferStatusCopy(t, direction, transfer.status, hosted)
    : {
        title: t("DashboardPayments.ramps.status.preparing"),
        description: t("DashboardPayments.ramps.status.preparingDescription"),
        state: "loading",
      };
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0">{statusIcon(copy.state)}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-primary">{copy.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-tertiary">{copy.description}</p>
      </div>
    </div>
  );
}
