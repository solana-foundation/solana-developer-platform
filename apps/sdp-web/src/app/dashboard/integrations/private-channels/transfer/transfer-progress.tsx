"use client";

import type { PrivateChannelTransfer } from "@sdp/types";
import { CheckCircle2Icon } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export function TransferProgress({
  transfer,
  senderLabel,
  recipientLabel,
  onReset,
}: {
  transfer: PrivateChannelTransfer;
  senderLabel?: string;
  recipientLabel?: string;
  onReset: () => void;
}) {
  const t = useTranslations();
  const failed = transfer.status === "failed";

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.transfer.progressLabel")}
          </p>
          <p className="font-semibold text-lg">
            {t("DashboardPrivateChannels.common.amountWithUnit", { amount: transfer.amount })}
          </p>
        </div>
        <StatusBadge status={transfer.status} t={t} />
      </div>

      <Outcome failureReason={transfer.failureReason} status={transfer.status} />

      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <dt className="text-secondary text-xs">
            {t("DashboardPrivateChannels.transfer.fromWallet")}
          </dt>
          <dd className="truncate font-medium text-sm">
            {senderLabel ?? t("DashboardPrivateChannels.transfer.senderFallback")}
          </dd>
          <dd className="break-all text-secondary text-xs">{transfer.sender}</dd>
        </div>
        <div className="min-w-0 space-y-1">
          <dt className="text-secondary text-xs">
            {t("DashboardPrivateChannels.transfer.toMemberWallet")}
          </dt>
          <dd className="truncate font-medium text-sm">
            {recipientLabel ?? t("DashboardPrivateChannels.transfer.recipientFallback")}
          </dd>
          <dd className="break-all text-secondary text-xs">{transfer.recipient}</dd>
        </div>
      </dl>

      {transfer.signature && (
        <p className="text-secondary text-xs">
          {t("DashboardPrivateChannels.transfer.signature")}{" "}
          <span className="break-all text-primary">{transfer.signature}</span>
        </p>
      )}

      <Button onClick={onReset} type="button" variant="secondary">
        {failed
          ? t("DashboardPrivateChannels.transfer.tryAgain")
          : t("DashboardPrivateChannels.transfer.newTransfer")}
      </Button>
    </div>
  );
}

/**
 * Only `confirmed` reads as success. `submitted` and `pending` are deliberately
 * inconclusive: SPC accepting a transaction is not the same as executing it, and
 * neither state has a verdict yet, so neither may render as done.
 */
const OUTCOME_TONE = {
  confirmed: "success",
  submitted: "unknown",
  pending: "unknown",
  failed: "error",
} as const satisfies Record<PrivateChannelTransfer["status"], string>;

const OUTCOME_KEYS = {
  confirmed: {
    title: "DashboardPrivateChannels.transfer.stageConfirmedTitle",
    description: "DashboardPrivateChannels.transfer.stageConfirmedDescription",
  },
  submitted: {
    title: "DashboardPrivateChannels.transfer.stageSubmittedTitle",
    description: "DashboardPrivateChannels.transfer.stageSubmittedDescription",
  },
  pending: {
    title: "DashboardPrivateChannels.transfer.stagePendingTitle",
    description: "DashboardPrivateChannels.transfer.stagePendingDescription",
  },
  failed: {
    title: "DashboardPrivateChannels.transfer.stageFailedTitle",
    description: "DashboardPrivateChannels.transfer.stageFailedDescription",
  },
} as const;

/**
 * A confirmed transfer reads as a completed step, matching the deposit and
 * withdrawal stage rows. The states that need the operator to act — an unknown
 * outcome or a failure — are tinted callouts instead, so they cannot be skimmed
 * past as done.
 */
function Outcome({
  failureReason,
  status,
}: {
  failureReason: string | null;
  status: PrivateChannelTransfer["status"];
}) {
  const t = useTranslations();
  const tone = OUTCOME_TONE[status];
  const keys = OUTCOME_KEYS[status];

  if (tone === "success") {
    return (
      <div className="flex items-start gap-3" role="status">
        <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-5 text-success" />
        <div className="space-y-0.5">
          <p className="font-medium text-primary text-sm">{t(keys.title)}</p>
          <p className="text-secondary text-xs">{t(keys.description)}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "space-y-0.5 rounded-lg border px-4 py-3",
        tone === "error"
          ? "border-error-border bg-error-bg text-error"
          : "border-warning-border bg-warning-bg text-warning"
      )}
      role={tone === "error" ? "alert" : "status"}
    >
      <p className="font-medium text-sm">{t(keys.title)}</p>
      <p className="text-xs">{(tone === "error" ? failureReason : null) ?? t(keys.description)}</p>
    </div>
  );
}

const STATUS_KEYS = {
  pending: "DashboardPrivateChannels.transfer.statusPending",
  submitted: "DashboardPrivateChannels.transfer.statusSubmitted",
  confirmed: "DashboardPrivateChannels.transfer.statusConfirmed",
  failed: "DashboardPrivateChannels.transfer.statusFailed",
} as const;

function StatusBadge({
  status,
  t,
}: {
  status: PrivateChannelTransfer["status"];
  t: ReturnType<typeof useTranslations>;
}) {
  const variant: BadgeVariant =
    status === "confirmed" ? "success" : status === "failed" ? "danger" : "default";

  return <Badge variant={variant}>{t(STATUS_KEYS[status])}</Badge>;
}
