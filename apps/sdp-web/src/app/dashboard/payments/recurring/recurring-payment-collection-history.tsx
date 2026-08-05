"use client";

import type {
  PaymentSubscriptionCollectionAttempt,
  PaymentSubscriptionCollectionAttemptStatus,
} from "@sdp/types";
import { RepeatIcon } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { formatDisplayAmount, formatTimestamp, shortenAddress } from "../payments-overview.utils";
import {
  CopyableValue,
  ExplorerValue,
  type RecurringPaymentWalletView,
  resolveTokenLabel,
} from "./recurring-payments-shared";

export const COLLECTION_STATUS_VARIANTS = {
  pending: "warning",
  processing: "info",
  confirmed: "success",
  failed: "danger",
  skipped: "default",
} as const satisfies Record<PaymentSubscriptionCollectionAttemptStatus, BadgeVariant>;

export const COLLECTION_STATUS_TRANSLATION_KEYS = {
  pending: "DashboardPayments.recurring.pending",
  processing: "DashboardPayments.recurring.processing",
  confirmed: "DashboardPayments.recurring.collected",
  failed: "DashboardPayments.recurring.failed",
  skipped: "DashboardPayments.recurring.skipped",
} as const satisfies Record<PaymentSubscriptionCollectionAttemptStatus, MessageKey>;

export const COLLECTION_ATTEMPTED_COLUMN_CLASS = "hidden lg:table-cell";
export const COLLECTION_TRANSFER_COLUMN_CLASS = "hidden xl:table-cell";

export function CollectionStatusBadge({
  status,
}: {
  status: PaymentSubscriptionCollectionAttemptStatus;
}) {
  const t = useTranslations();
  return (
    <Badge variant={COLLECTION_STATUS_VARIANTS[status]}>
      {t(COLLECTION_STATUS_TRANSLATION_KEYS[status])}
    </Badge>
  );
}

export function RecurringPaymentCollectionHistory({
  attempts,
  total,
  error,
  wallets,
  className,
}: {
  className?: string;
  attempts: PaymentSubscriptionCollectionAttempt[];
  total: number;
  error?: string;
  wallets: RecurringPaymentWalletView[];
}) {
  const t = useTranslations();
  const attemptsLabel =
    total > attempts.length
      ? t("DashboardPayments.recurring.showingAttempts", { shown: attempts.length, total })
      : attempts.length === 1
        ? t("DashboardPayments.recurring.oneAttempt")
        : t("DashboardPayments.recurring.attempts", { count: attempts.length });

  return (
    <Card
      className={cn(
        "flex flex-col gap-0 overflow-hidden rounded-lg border border-border-default bg-surface-raised py-0 shadow-none ring-0",
        className
      )}
    >
      <CardHeader className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{t("DashboardPayments.recurring.collectionHistory")}</CardTitle>
          {attempts.length > 0 ? <CardDescription>{attemptsLabel}</CardDescription> : null}
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col px-0">
        {error ? (
          <div
            role="alert"
            className="border border-error-border bg-error-bg p-4 text-sm text-error"
          >
            {t("DashboardPayments.recurring.unableToLoadCollectionHistory", { error })}
          </div>
        ) : attempts.length === 0 ? (
          <ListEmptyState
            icon={<RepeatIcon className="size-5" />}
            message={t("DashboardPayments.recurring.noCollectionAttempts")}
          />
        ) : (
          <>
            <div className="divide-y divide-border-default md:hidden">
              {attempts.map((attempt) => (
                <div key={attempt.id} className="space-y-1.5 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <CollectionStatusBadge status={attempt.status} />
                    <span className="truncate text-sm font-medium text-primary">
                      {formatDisplayAmount(
                        attempt.amount,
                        resolveTokenLabel(attempt.token, wallets)
                      )}
                    </span>
                  </div>
                  <p className="truncate text-xs text-secondary">
                    {formatTimestamp(attempt.dueAt, t)}
                  </p>
                  {attempt.error ? (
                    <p className="truncate text-xs text-error">{attempt.error}</p>
                  ) : null}
                </div>
              ))}
            </div>
            <Table className="hidden rounded-none border-0 w-full [&_table]:table-fixed md:block">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[26%] lg:w-[22%] xl:w-[18%]">
                    {t("DashboardPayments.recurring.due")}
                  </TableHead>
                  <TableHead
                    className={`${COLLECTION_ATTEMPTED_COLUMN_CLASS} lg:w-[20%] xl:w-[18%]`}
                  >
                    {t("DashboardPayments.recurring.attempted")}
                  </TableHead>
                  <TableHead className="w-[26%] lg:w-[20%] xl:w-[16%]">
                    {t("DashboardPayments.recurring.amount")}
                  </TableHead>
                  <TableHead className="w-[24%] lg:w-[20%] xl:w-[16%]">
                    {t("DashboardPayments.status")}
                  </TableHead>
                  <TableHead className={`${COLLECTION_TRANSFER_COLUMN_CLASS} xl:w-[14%]`}>
                    {t("DashboardPayments.recurring.transfer")}
                  </TableHead>
                  <TableHead className="w-[24%] lg:w-[18%] xl:w-[18%]">
                    {t("DashboardPayments.recurring.explorer")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attempts.map((attempt) => (
                  <TableRow key={attempt.id}>
                    <TableCell className="whitespace-nowrap text-sm">
                      <span className="block truncate">{formatTimestamp(attempt.dueAt, t)}</span>
                    </TableCell>
                    <TableCell
                      className={`${COLLECTION_ATTEMPTED_COLUMN_CLASS} whitespace-nowrap text-sm text-secondary`}
                    >
                      <span className="block truncate">
                        {attempt.attemptedAt
                          ? formatTimestamp(attempt.attemptedAt, t)
                          : t("DashboardPayments.recurring.notSet")}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm font-medium">
                      <span className="block truncate">
                        {formatDisplayAmount(
                          attempt.amount,
                          resolveTokenLabel(attempt.token, wallets)
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <CollectionStatusBadge status={attempt.status} />
                        {attempt.error ? (
                          <p className="max-w-[14rem] truncate text-xs text-error">
                            {attempt.error}
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className={COLLECTION_TRANSFER_COLUMN_CLASS}>
                      <CopyableValue
                        value={attempt.transferId}
                        label={attempt.transferId ? shortenAddress(attempt.transferId) : undefined}
                      />
                    </TableCell>
                    <TableCell>
                      <ExplorerValue value={attempt.signature} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
