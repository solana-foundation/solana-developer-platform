"use client";

import type { PaymentTransferBatch } from "@sdp/types";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { toTitleCase } from "../activity-format-utils";
import { BatchRecipientsList } from "./batch-recipients-list";
import {
  batchStatusClassName,
  formatDisplayAmount,
  formatTimestamp,
} from "./payments-overview.utils";
import { fetchTransferBatches } from "./payments-workspace.data";

const BATCHES_PAGE_SIZE = 20;

function BatchRow({
  batch,
  expanded,
  onToggle,
}: {
  batch: PaymentTransferBatch;
  expanded: boolean;
  onToggle: (batchId: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const amountLabel = formatDisplayAmount(batch.totalAmount, batch.token, locale);
  const recipientCountLabel = t(
    batch.recipientCount === 1
      ? "DashboardPayments.batchActivity.recipientCountSingular"
      : "DashboardPayments.batchActivity.recipientCountPlural",
    { count: batch.recipientCount }
  );
  const createdLabel = formatTimestamp(batch.createdAt, t, locale);

  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={() => onToggle(batch.id)}
        aria-expanded={expanded}
      >
        <TableCell>
          <span
            className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${batchStatusClassName(batch.status)}`}
          >
            {toTitleCase(batch.status)}
          </span>
        </TableCell>
        <TableCell className="min-w-0 max-w-0 font-medium">
          <div className="min-w-0">
            <span className="block max-w-full truncate">{amountLabel}</span>
            <div className="mt-1 text-xs font-normal text-tertiary sm:hidden">
              <span>{recipientCountLabel}</span>
              <span className="mx-1.5">·</span>
              <span>{createdLabel}</span>
            </div>
            {batch.externalId ? (
              <span
                className="mt-1 hidden max-w-full truncate text-xs font-normal text-tertiary sm:block"
                title={batch.externalId}
              >
                {batch.externalId}
              </span>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="hidden text-secondary sm:table-cell">{recipientCountLabel}</TableCell>
        <TableCell className="hidden text-secondary md:table-cell">{createdLabel}</TableCell>
        <TableCell className="w-10 text-right">
          <ChevronDownIcon
            aria-hidden
            className={cn("size-4 text-tertiary transition-transform", expanded && "rotate-180")}
          />
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={5} className="bg-fill-subtle p-0">
            <BatchRecipientsList batchId={batch.id} batchStatus={batch.status} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export function TransferBatchesTable({ walletId }: { walletId?: string }) {
  const t = useTranslations();
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<string>>(() => new Set());
  const { data: batches, error } = useSWR(
    ["payment-transfer-batches", walletId],
    () =>
      fetchTransferBatches({ pageSize: BATCHES_PAGE_SIZE, ...(walletId ? { walletId } : {}) }, t),
    { refreshInterval: 10_000 }
  );

  const toggleBatch = (batchId: string) => {
    setExpandedBatchIds((current) => {
      const next = new Set(current);
      if (next.has(batchId)) {
        next.delete(batchId);
      } else {
        next.add(batchId);
      }
      return next;
    });
  };

  if (error) {
    const message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : t("DashboardPayments.batchActivity.recipientsLoadFailed");
    return <p className="text-sm text-destructive-strong">{message}</p>;
  }

  if (!batches) {
    return (
      <div className="grid gap-2">
        <SkeletonBlock className="h-12 w-full" />
        <SkeletonBlock className="h-12 w-full" />
      </div>
    );
  }

  if (batches.length === 0) {
    return (
      <p className="text-sm text-secondary">{t("DashboardPayments.batchActivity.noBatches")}</p>
    );
  }

  return (
    <Table className="min-w-0 [&_table]:table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[8.75rem]">{t("DashboardPayments.status")}</TableHead>
          <TableHead>{t("DashboardPayments.batchActivity.amount")}</TableHead>
          <TableHead className="hidden w-[10rem] sm:table-cell">
            {t("DashboardPayments.batchActivity.recipients")}
          </TableHead>
          <TableHead className="hidden w-[10rem] md:table-cell">
            {t("DashboardPayments.createdLabel")}
          </TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {batches.map((batch) => (
          <BatchRow
            key={batch.id}
            batch={batch}
            expanded={expandedBatchIds.has(batch.id)}
            onToggle={toggleBatch}
          />
        ))}
      </TableBody>
    </Table>
  );
}
