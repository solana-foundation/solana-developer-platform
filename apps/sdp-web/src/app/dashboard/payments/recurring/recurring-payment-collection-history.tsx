"use client";

import type {
  PaymentSubscriptionCollectionAttempt,
  PaymentSubscriptionCollectionAttemptStatus,
} from "@sdp/types";
import { ArrowUpRightIcon } from "lucide-react";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";
import { shortenAddress } from "../payments-overview.utils";
import { formatDate, formatDateTime, formatDecimalAmount } from "../payments-presentation";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "../payments-table";

/** How each run reads: collected, still moving, waiting, went wrong, or passed over. */
const RUN_STATUS_TONES = {
  pending: "attention",
  processing: "progress",
  confirmed: "positive",
  failed: "critical",
  skipped: "neutral",
} as const satisfies Record<PaymentSubscriptionCollectionAttemptStatus, StatusTone>;

const RUN_STATUS_KEYS = {
  pending: "DashboardPayments.recurring.pending",
  processing: "DashboardPayments.recurring.processing",
  confirmed: "DashboardPayments.recurring.collected",
  failed: "DashboardPayments.recurring.failed",
  skipped: "DashboardPayments.recurring.skipped",
} as const satisfies Record<PaymentSubscriptionCollectionAttemptStatus, MessageKey>;

/**
 * The runs a schedule has made, newest first as the API returns them, in the design's six
 * columns: when it was due, when it was tried, the amount, the outcome with its reason under
 * it, the transfer it made, and the transaction in Explorer.
 */
export function RecurringPaymentRunHistory({
  attempts,
  error,
  tokenLabel,
  pendingActivation,
}: {
  attempts: PaymentSubscriptionCollectionAttempt[];
  error?: string;
  /** The schedule's token; every run pays in it. */
  tokenLabel: string;
  /** A schedule not yet activated has made no runs, and says when its first will be. */
  pendingActivation: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const cluster = useSolanaCluster();
  const none = <span className="text-tertiary">{t("DashboardPayments.recurring.none")}</span>;

  if (error) {
    return (
      <p role="alert" className="text-body text-error">
        {t("DashboardPayments.recurring.runHistoryUnavailable", { error })}
      </p>
    );
  }
  if (attempts.length === 0) {
    return (
      <ListEmptyState
        message={t("DashboardPayments.recurring.noRunsTitle")}
        description={
          pendingActivation
            ? t("DashboardPayments.recurring.noRunsPendingBody")
            : t("DashboardPayments.recurring.noRunsBody")
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto refresh:-mx-3">
      <Table className="min-w-[820px] table-fixed rounded-none border-0" data-schedule-runs>
        <colgroup>
          <col className="w-[13%]" />
          <col className="w-[17%]" />
          <col className="w-[14%]" />
          <col className="w-[26%]" />
          <col className="w-[17%]" />
          <col className="w-[13%]" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead className={PAYMENTS_TABLE_HEAD}>
              {t("DashboardPayments.recurring.due")}
            </TableHead>
            <TableHead className={PAYMENTS_TABLE_HEAD}>
              {t("DashboardPayments.recurring.attempted")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "text-right")}>
              {t("DashboardPayments.recurring.amount")}
            </TableHead>
            <TableHead className={PAYMENTS_TABLE_HEAD}>{t("DashboardPayments.status")}</TableHead>
            <TableHead className={PAYMENTS_TABLE_HEAD}>
              {t("DashboardPayments.recurring.transfer")}
            </TableHead>
            <TableHead className={PAYMENTS_TABLE_HEAD}>
              {t("DashboardPayments.recurring.explorer")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attempts.map((attempt) => (
            // Rows grow with a reason, every cell on the first line's baseline.
            <TableRow key={attempt.id} className="[--table-cell-padding-y:10px] [&>td]:align-top">
              <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-primary tabular-nums")}>
                {formatDate(attempt.dueAt, locale)}
              </TableCell>
              <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-secondary tabular-nums")}>
                {attempt.attemptedAt ? (
                  formatDateTime(attempt.attemptedAt, locale)
                ) : (
                  <span className="text-tertiary">
                    {t("DashboardPayments.recurring.notAttempted")}
                  </span>
                )}
              </TableCell>
              <TableCell
                className={cn(PAYMENTS_TABLE_CELL, "text-right whitespace-nowrap tabular-nums")}
              >
                <span className="font-medium text-primary">
                  {formatDecimalAmount(attempt.amount, locale)}
                </span>
                <span className="text-secondary"> {tokenLabel}</span>
              </TableCell>
              <TableCell className={cn(PAYMENTS_TABLE_CELL, "whitespace-normal")}>
                <StatusText tone={RUN_STATUS_TONES[attempt.status]} className="block">
                  {t(RUN_STATUS_KEYS[attempt.status])}
                </StatusText>
                {attempt.error ? (
                  <span className="block break-words text-secondary">{attempt.error}</span>
                ) : null}
              </TableCell>
              <TableCell className={PAYMENTS_TABLE_CELL}>
                {attempt.transferId ? (
                  <span className="-my-0.5 inline-flex max-w-full items-center gap-1.5">
                    <span className="truncate text-primary tabular-nums" title={attempt.transferId}>
                      {shortenAddress(attempt.transferId)}
                    </span>
                    <WalletMetadataCopyButton
                      value={attempt.transferId}
                      label={t("DashboardPayments.recurring.transfer")}
                    />
                  </span>
                ) : (
                  none
                )}
              </TableCell>
              <TableCell className={PAYMENTS_TABLE_CELL}>
                {attempt.signature ? (
                  <a
                    href={explorerTxUrl(attempt.signature, cluster)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-secondary hover:text-primary focus-visible:underline focus-visible:outline-none"
                  >
                    {t("DashboardPayments.recurring.open")}
                    <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
                  </a>
                ) : (
                  none
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
