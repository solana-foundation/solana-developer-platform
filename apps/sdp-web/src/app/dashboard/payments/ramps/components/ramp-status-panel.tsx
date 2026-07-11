"use client";

import type { PaymentTransferSummary } from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";

interface TransferStatusCopy {
  title: string;
  description: string;
  state: "loading" | "success" | "error";
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;

function transferStatusCopy(
  t: Translate,
  direction: RampDirection,
  status: string
): TransferStatusCopy {
  const onramp = direction === "onramp";
  switch (status) {
    case "pending":
    case "awaiting_payment":
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
          : // biome-ignore lint/security/noSecrets: Translation catalog key, not a credential.
            t("DashboardPayments.ramps.status.quoteExpiredPayoutDescription"),
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

function statusIcon(state: TransferStatusCopy["state"]) {
  switch (state) {
    case "success":
      return <CheckCircle2Icon className="size-5 text-status-success-text" />;
    case "error":
      return <XCircleIcon className="size-5 text-status-error-text" />;
    case "loading":
      return <Loader2Icon className="size-5 animate-spin text-text-medium" />;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled transfer status state: ${exhaustive}`);
    }
  }
}

export function RampStatusPanel({
  direction,
  transfer,
}: {
  direction: RampDirection;
  transfer: PaymentTransferSummary | null | undefined;
}) {
  const t = useTranslations();
  const copy: TransferStatusCopy = transfer
    ? transferStatusCopy(t, direction, transfer.status)
    : {
        title: t("DashboardPayments.ramps.status.preparing"),
        description: t("DashboardPayments.ramps.status.preparingDescription"),
        state: "loading",
      };
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0">{statusIcon(copy.state)}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-extra-high">{copy.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-text-low">{copy.description}</p>
      </div>
    </div>
  );
}
