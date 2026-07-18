"use client";

import type { PaymentTransferBatchRecipientStatus, PaymentTransferBatchStatus } from "@sdp/types";
import { ExternalLinkIcon } from "lucide-react";
import useSWR from "swr";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  batchStatusClassName,
  formatDisplayAmount,
  isTerminalBatchStatus,
  resolveBatchTokenLabel,
  shortenAddress,
} from "./payments-overview.utils";
import {
  fetchBatchRecipients,
  fetchTransferBatch,
  getDevnetExplorerUrl,
} from "./payments-workspace.data";

interface BatchRecipientsListProps {
  batchId: string;
  batchStatus: PaymentTransferBatchStatus;
}

type Translate = ReturnType<typeof useTranslations>;

function recipientStatusLabel(status: PaymentTransferBatchRecipientStatus, t: Translate): string {
  switch (status) {
    case "pending":
      return t("DashboardPayments.batchSend.recipientStatusPending");
    case "processing":
      return t("DashboardPayments.batchSend.recipientStatusProcessing");
    case "confirmed":
      return t("DashboardPayments.batchSend.recipientStatusConfirmed");
    case "failed":
      return t("DashboardPayments.batchSend.recipientStatusFailed");
    case "archived":
      return t("DashboardPayments.batchSend.recipientStatusArchived");
  }
}

export function BatchRecipientsList({ batchId, batchStatus }: BatchRecipientsListProps) {
  const t = useTranslations();
  const locale = useLocale();
  const terminal = isTerminalBatchStatus(batchStatus);
  const { data, error } = useSWR(
    ["payment-transfer-batch", batchId],
    ([, id]) => fetchTransferBatch(id, t),
    {
      revalidateOnFocus: !terminal,
      refreshInterval: terminal ? 0 : 10_000,
    }
  );

  const recipientAccountIds = data
    ? [...new Set(data.recipients.map((recipient) => recipient.counterpartyAccountId))]
    : [];
  const { data: counterpartyAccounts, error: counterpartyAccountsError } = useSWR(
    recipientAccountIds.length > 0 ? ["batch-recipient-counterparties", batchId] : null,
    () => fetchBatchRecipients({ ids: recipientAccountIds }, t),
    { revalidateOnFocus: false, revalidateIfStale: false }
  );
  const counterpartyNamesPending =
    recipientAccountIds.length > 0 && !counterpartyAccounts && !counterpartyAccountsError;
  const counterpartyNameByAccountId = new Map<string, string>(
    counterpartyAccounts
      ? counterpartyAccounts.accounts.map((account) => [
          account.counterpartyAccountId,
          account.name,
        ])
      : []
  );

  if (error) {
    const message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : t("DashboardPayments.batchActivity.recipientsLoadFailed");
    return <p className="px-4 py-3 text-sm text-destructive-strong">{message}</p>;
  }

  if (!data || counterpartyNamesPending) {
    return (
      <div className="grid gap-2 px-4 py-3">
        <SkeletonBlock className="h-12 w-full" />
        <SkeletonBlock className="h-12 w-full" />
      </div>
    );
  }

  if (data.recipients.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-secondary">
        {t("DashboardPayments.batchActivity.noRecipients")}
      </p>
    );
  }

  const signatureByTransfer = new Map(
    data.transfers.map((transfer) => [transfer.id, transfer.signature])
  );

  return (
    <div className="divide-y divide-border-default">
      {data.recipients.map((recipient) => {
        const signature = recipient.transferId
          ? signatureByTransfer.get(recipient.transferId)
          : null;
        const counterpartyName = counterpartyNameByAccountId.get(recipient.counterpartyAccountId);
        const amountLabel = formatDisplayAmount(
          recipient.amount,
          resolveBatchTokenLabel(data.batch.token),
          locale
        );

        return (
          <div
            key={recipient.id}
            className="flex min-w-0 items-center justify-between gap-4 px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-primary" title={recipient.destination}>
                {counterpartyName ? counterpartyName : shortenAddress(recipient.destination)}
              </p>
              <p className="mt-0.5 truncate text-xs text-tertiary" title={recipient.destination}>
                {counterpartyName
                  ? `${shortenAddress(recipient.destination)} · ${amountLabel}`
                  : amountLabel}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={cn(
                  "inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold",
                  batchStatusClassName(recipient.status)
                )}
              >
                {recipientStatusLabel(recipient.status, t)}
              </span>
              {signature ? (
                <a
                  href={getDevnetExplorerUrl(signature)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-tertiary hover:text-primary"
                  aria-label={t("DashboardPayments.batchActivity.viewOnExplorer")}
                >
                  <ExternalLinkIcon className="size-4" />
                </a>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
