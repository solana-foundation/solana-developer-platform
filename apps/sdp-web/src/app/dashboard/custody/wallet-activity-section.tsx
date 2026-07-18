"use client";

import { ExternalLink, RefreshCwIcon } from "lucide-react";
import useSWR from "swr";
import {
  fetchWalletActivity,
  type WalletActivityPayload,
  type WalletActivityRow,
} from "@/app/dashboard/custody/wallet-activity.data";
import { getDevnetExplorerUrl } from "@/app/dashboard/payments/payments-workspace.data";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatDisplayAmount } from "../payments/payments-overview.utils";

interface WalletActivitySectionProps {
  walletId: string;
  initialActivity: WalletActivityPayload;
}

function formatTimestamp(value: string | undefined, locale: string): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusClassName(status: string): string {
  if (status === "confirmed") {
    return "border-success-border bg-success-bg text-success";
  }

  if (status === "failed") {
    return "border-destructive-border bg-destructive-bg text-destructive-strong";
  }

  return "border-border-default bg-fill-subtle text-secondary";
}

function TruncatedText({ value, className }: { value: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={className ?? "truncate"}>{value}</div>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[32rem] break-all text-xs">
        {value}
      </TooltipContent>
    </Tooltip>
  );
}

export function WalletActivitySection({ walletId, initialActivity }: WalletActivitySectionProps) {
  const t = useTranslations();
  const locale = useLocale();
  const hasInitialActivity = initialActivity.activityError === null;
  const {
    data: swrActivity,
    error: requestError,
    isValidating,
    mutate,
  } = useSWR(`wallet-activity-${walletId}`, () => fetchWalletActivity(walletId), {
    fallbackData: initialActivity,
    revalidateOnMount: hasInitialActivity ? false : undefined,
    revalidateIfStale: hasInitialActivity ? false : undefined,
    revalidateOnFocus: true,
    refreshWhenHidden: false,
    refreshInterval: 20_000,
  });
  const liveActivity = swrActivity ?? initialActivity;
  const liveRows = Array.isArray(liveActivity.activityRows) ? liveActivity.activityRows : [];
  const requestErrorMessage = requestError
    ? requestError instanceof Error
      ? requestError.message || t("DashboardCustody.walletActivityUnavailable")
      : t("DashboardCustody.unableToLoadWallets")
    : null;
  const liveActivityError =
    requestErrorMessage && liveRows.length === 0 ? requestErrorMessage : liveActivity.activityError;
  const liveActivityNotice =
    requestErrorMessage && liveRows.length > 0 ? requestErrorMessage : liveActivity.activityNotice;

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle>{t("DashboardCustody.recentActivity")}</CardTitle>
          <CardDescription>{t("DashboardCustody.recentActivityDescription")}</CardDescription>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          iconLeft={<RefreshCwIcon className={isValidating ? "animate-spin" : undefined} />}
          onClick={() => void mutate()}
          disabled={isValidating}
        >
          {isValidating ? t("DashboardCustody.refreshing") : t("DashboardCustody.refresh")}
        </Button>
      </CardHeader>
      <CardContent>
        {liveActivityError ? (
          <p className="text-sm text-destructive-strong">{liveActivityError}</p>
        ) : liveRows.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-secondary">{t("DashboardCustody.noWalletActivity")}</p>
            {liveActivityNotice ? (
              <p className="text-xs text-tertiary">{liveActivityNotice}</p>
            ) : null}
          </div>
        ) : (
          <TooltipProvider>
            <div className="min-w-0 space-y-3">
              {liveActivityNotice ? (
                <p className="text-xs text-tertiary">{liveActivityNotice}</p>
              ) : null}
              <Table className="[&_table]:table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[9rem]">{t("DashboardCustody.status")}</TableHead>
                    <TableHead className="w-[calc(100%-9rem)] md:w-[22%]">
                      <span className="md:hidden">{t("DashboardCustody.activity")}</span>
                      <span className="hidden md:inline">{t("DashboardCustody.asset")}</span>
                    </TableHead>
                    <TableHead className="hidden w-[8rem] md:table-cell">
                      {t("DashboardCustody.direction")}
                    </TableHead>
                    <TableHead className="hidden w-[26%] md:table-cell">
                      {t("DashboardCustody.counterparty")}
                    </TableHead>
                    <TableHead className="hidden w-[22%] md:table-cell">
                      {t("DashboardCustody.signature")}
                    </TableHead>
                    <TableHead className="hidden w-[10rem] md:table-cell">
                      {t("DashboardCustody.created")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {liveRows.map((row: WalletActivityRow) => {
                    const assetLabel =
                      row.amount && row.token
                        ? formatDisplayAmount(row.amount, row.token, locale)
                        : (row.token ?? t("DashboardCustody.unknownAsset"));
                    const createdLabel = formatTimestamp(row.createdAt, locale);
                    const address = row.address ?? t("DashboardCustody.unknown");

                    return (
                      <TableRow key={row.id}>
                        <TableCell>
                          <span
                            className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClassName(row.status)}`}
                          >
                            {row.status}
                          </span>
                        </TableCell>
                        <TableCell className="min-w-0 font-medium">
                          <div className="min-w-0">
                            <TruncatedText value={assetLabel} className="truncate" />
                            <div className="mt-1 text-xs font-normal text-tertiary md:hidden">
                              <span>{row.operationLabel}</span>
                              <span className="mx-1.5">·</span>
                              <span>{createdLabel}</span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden text-secondary md:table-cell">
                          {row.operationLabel}
                        </TableCell>
                        <TableCell className="hidden min-w-0 font-mono text-xs text-secondary md:table-cell">
                          <TruncatedText value={address} className="truncate" />
                        </TableCell>
                        <TableCell className="hidden min-w-0 font-mono text-xs md:table-cell">
                          {row.signature ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <a
                                  href={getDevnetExplorerUrl(row.signature)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex min-w-0 items-center gap-1 text-primary underline underline-offset-2"
                                >
                                  <span className="block min-w-0 truncate">{row.signature}</span>
                                  <ExternalLink className="size-3 shrink-0" />
                                </a>
                              </TooltipTrigger>
                              <TooltipContent
                                side="top"
                                align="start"
                                className="max-w-[32rem] break-all text-xs"
                              >
                                {row.signature}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-tertiary">{t("DashboardCustody.pending")}</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden text-secondary md:table-cell">
                          {createdLabel}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TooltipProvider>
        )}
      </CardContent>
    </Card>
  );
}
