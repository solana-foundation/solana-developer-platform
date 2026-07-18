"use client";

import type {
  Counterparty,
  CustodyWalletAggregate,
  PaymentTransferSummary as TransferRecord,
} from "@sdp/types";
import { ExternalLink, RefreshCwIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { SectionEntry } from "@/app/dashboard/wallets/section-entry";
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
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import {
  formatCurrencyAmount,
  formatDirection,
  formatDisplayAmount,
  formatTimestamp,
  normalizeAggregateBalances,
  resolveAggregateBalanceDisplayToken,
  resolveCounterparty,
  resolveTotalBalance,
  resolveTransferTypeLabel,
  resolveUsdBalanceValue,
  selectTopAggregateBalanceRows,
} from "./payments-overview.utils";
import {
  fetchTransfers,
  fetchWalletAggregate,
  getDevnetExplorerUrl,
} from "./payments-workspace.data";

interface PaymentsOverviewProps {
  aggregate: CustodyWalletAggregate | null;
  aggregateError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  counterparties: Counterparty[];
  transfers: TransferRecord[];
  transfersError: string | null;
}

const PAYMENTS_OVERVIEW_AGGREGATE_KEY = "payments-overview-aggregate";
const PAYMENTS_OVERVIEW_TRANSFERS_KEY = "payments-overview-transfers";
const PAYMENTS_OVERVIEW_AGGREGATE_CACHE_TTL_MS = 30_000;
const PAYMENTS_OVERVIEW_TRANSFERS_CACHE_TTL_MS = 20_000;

function statusClassName(status: string): string {
  switch (status.toLowerCase()) {
    case "confirmed":
    case "finalized":
      return "border-success-border bg-success-bg text-success";
    case "processing":
    case "pending":
      return "border-warning-border bg-warning-bg text-warning";
    case "failed":
      return "border-destructive-border bg-destructive-bg text-destructive-strong";
    default:
      return "border-border-default bg-fill-subtle text-secondary";
  }
}

function resolveRequestError(
  error: unknown,
  fallback: string | null,
  requestFailed: string
): string | null {
  if (error instanceof Error) {
    return error.message;
  }

  if (error) {
    return requestFailed;
  }

  return fallback;
}

function truncateHash(value: string, prefix = 10, suffix = 8): string {
  if (value.length <= prefix + suffix + 3) {
    return value;
  }

  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

function TruncatedTableText({
  value,
  displayValue,
  className,
}: {
  value: string;
  displayValue?: string;
  className?: string;
}) {
  const renderedValue = displayValue ?? value;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={className ?? "block max-w-full truncate"}>
          {renderedValue === value ? (
            value
          ) : (
            <>
              <span aria-hidden="true">{renderedValue}</span>
              <span className="sr-only">{value}</span>
            </>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[32rem] break-all text-xs">
        {value}
      </TooltipContent>
    </Tooltip>
  );
}

export function PaymentsOverview({
  aggregate,
  aggregateError,
  issuedTokenSymbolsByMint,
  counterparties,
  transfers,
  transfersError,
}: PaymentsOverviewProps) {
  const t = useTranslations();
  const locale = useLocale();
  const searchParams = useSearchParams();
  const refreshSeed = searchParams.get("refresh") ?? "default";
  const {
    data: swrAggregate,
    error: aggregateFetchError,
    isValidating: aggregateRefreshing,
    mutate: mutateAggregate,
  } = usePersistedDashboardSWR<CustodyWalletAggregate>(
    [PAYMENTS_OVERVIEW_AGGREGATE_KEY, refreshSeed],
    () => fetchWalletAggregate(t),
    {
      fallbackData: aggregateError || !aggregate ? undefined : aggregate,
      revalidateOnFocus: true,
      refreshInterval: 30_000,
    },
    {
      key: "payments.aggregate",
      ttlMs: PAYMENTS_OVERVIEW_AGGREGATE_CACHE_TTL_MS,
    }
  );
  const {
    data: swrTransfers,
    error: transfersFetchError,
    isValidating: transfersRefreshing,
    mutate: mutateTransfers,
  } = usePersistedDashboardSWR<TransferRecord[]>(
    [PAYMENTS_OVERVIEW_TRANSFERS_KEY, refreshSeed],
    () => fetchTransfers({ pageSize: 20 }, t),
    {
      fallbackData: transfersError ? undefined : transfers,
      revalidateOnFocus: true,
      refreshInterval: 10_000,
    },
    {
      key: "payments.transfers.recent",
      ttlMs: PAYMENTS_OVERVIEW_TRANSFERS_CACHE_TTL_MS,
    }
  );

  const liveAggregate = swrAggregate ?? aggregate;
  const liveTransfers = swrTransfers ?? transfers;
  const liveAggregateError = aggregateFetchError
    ? resolveRequestError(aggregateFetchError, aggregateError, t("DashboardPayments.requestFailed"))
    : swrAggregate === undefined
      ? aggregateError
      : null;
  const liveTransfersError = transfersFetchError
    ? resolveRequestError(transfersFetchError, transfersError, t("DashboardPayments.requestFailed"))
    : swrTransfers === undefined
      ? transfersError
      : null;
  const isRefreshing = aggregateRefreshing || transfersRefreshing;
  const aggregateBalances = useMemo(
    () => normalizeAggregateBalances(liveAggregate?.balances ?? []),
    [liveAggregate]
  );
  const topAggregateBalances = useMemo(
    () => selectTopAggregateBalanceRows(aggregateBalances, issuedTokenSymbolsByMint),
    [aggregateBalances, issuedTokenSymbolsByMint]
  );
  const totalBalance = resolveTotalBalance(aggregateBalances);
  const walletCount = liveAggregate?.walletCount ?? 0;
  const counterpartyNamesById = useMemo(
    () =>
      new Map(counterparties.map((counterparty) => [counterparty.id, counterparty.displayName])),
    [counterparties]
  );

  const handleRefresh = () => {
    void Promise.all([mutateAggregate(), mutateTransfers()]);
  };

  return (
    <div className="grid min-w-0 gap-6 overflow-x-hidden">
      <SectionEntry delay={0.04}>
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,1fr)]">
          <div className="flex min-h-[244px] flex-col justify-center rounded-[4px] bg-fill-subtle px-8 py-10 sm:px-14">
            <div className="space-y-3">
              <p className="text-[15px] font-medium tracking-[0.01em] text-primary">
                {t("DashboardPayments.totalSdpBalance")}
              </p>
              <p className="text-[38px] leading-none font-medium tracking-[-0.05em] text-primary sm:text-[54px]">
                {formatCurrencyAmount(totalBalance, locale)}
              </p>
              <p className="text-sm text-tertiary">
                {t("DashboardPayments.aggregatedAcrossWallets", {
                  count: walletCount,
                  walletLabel: t(
                    walletCount === 1 ? "DashboardPayments.wallet" : "DashboardPayments.wallets"
                  ),
                })}
              </p>
            </div>
          </div>

          <div className="grid min-w-0 gap-1.5">
            {topAggregateBalances.length > 0 ? (
              topAggregateBalances.map((balance) => {
                const usdValue = resolveUsdBalanceValue(balance);
                const displayToken = resolveAggregateBalanceDisplayToken(
                  balance,
                  issuedTokenSymbolsByMint
                );

                return (
                  <div
                    key={`${balance.token}-${balance.mint}`}
                    className="flex min-h-[78px] min-w-0 items-center justify-between gap-4 overflow-hidden rounded-[4px] bg-fill-subtle px-6 py-5"
                  >
                    <p
                      className="min-w-0 truncate text-[18px] font-medium tracking-[0.04em] text-primary uppercase"
                      title={displayToken}
                    >
                      {displayToken}
                    </p>
                    <p
                      className="min-w-0 max-w-[40%] truncate text-right text-[18px] font-medium tracking-[0.01em] text-primary sm:text-[20px]"
                      title={formatCurrencyAmount(usdValue, locale)}
                    >
                      {formatCurrencyAmount(usdValue, locale)}
                    </p>
                  </div>
                );
              })
            ) : (
              <div className="flex min-h-[78px] items-center rounded-[4px] bg-fill-subtle px-6 py-5 text-sm text-secondary">
                {t("DashboardPayments.noUsdValuedAssets")}
              </div>
            )}
          </div>
        </div>

        {liveAggregateError ? (
          <p className="mt-4 text-sm text-destructive-strong">{liveAggregateError}</p>
        ) : null}
      </SectionEntry>

      <SectionEntry delay={0.08}>
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <CardTitle>{t("DashboardPayments.recentTransactions")}</CardTitle>
              <CardDescription className="hidden sm:block">
                {t("DashboardPayments.recentTransactionsDescription")}
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="hidden sm:inline-flex"
              iconLeft={<RefreshCwIcon className={isRefreshing ? "animate-spin" : undefined} />}
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              {isRefreshing ? t("DashboardPayments.refreshing") : t("DashboardPayments.refresh")}
            </Button>
          </CardHeader>
          <CardContent>
            {liveTransfersError ? (
              <p className="text-sm text-destructive-strong">{liveTransfersError}</p>
            ) : liveTransfers.length === 0 ? (
              <p className="text-sm text-secondary">{t("DashboardPayments.noTransactions")}</p>
            ) : (
              <TooltipProvider>
                <Table className="min-w-0 [&_table]:table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[8.75rem]">{t("DashboardPayments.status")}</TableHead>
                      <TableHead className="hidden w-[8rem] lg:table-cell">
                        {t("DashboardPayments.type")}
                      </TableHead>
                      <TableHead className="w-[calc(100%-8.75rem)] lg:w-[16rem] xl:w-[20%]">
                        <span className="lg:hidden">{t("DashboardPayments.transfer")}</span>
                        <span className="hidden lg:inline">{t("DashboardPayments.asset")}</span>
                      </TableHead>
                      <TableHead className="hidden w-[8rem] lg:table-cell">
                        {t("DashboardPayments.direction")}
                      </TableHead>
                      <TableHead className="hidden xl:table-cell xl:w-[26%]">
                        {t("DashboardPayments.counterpartyLabel")}
                      </TableHead>
                      <TableHead className="hidden 2xl:table-cell 2xl:w-[22%]">
                        {t("DashboardPayments.signature")}
                      </TableHead>
                      <TableHead className="hidden w-[10rem] lg:table-cell">
                        {t("DashboardPayments.createdLabel")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {liveTransfers.map((transfer) => {
                      const counterparty = resolveCounterparty(transfer, counterpartyNamesById);
                      const assetLabel = formatDisplayAmount(
                        transfer.amount,
                        transfer.token,
                        locale
                      );
                      const directionLabel = formatDirection(transfer.direction, t);
                      const typeLabel = resolveTransferTypeLabel(transfer.type, t);
                      const createdLabel = formatTimestamp(transfer.createdAt, t, locale);

                      return (
                        <TableRow key={transfer.id}>
                          <TableCell>
                            <span
                              className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClassName(transfer.status)}`}
                            >
                              {transfer.status}
                            </span>
                          </TableCell>
                          <TableCell className="hidden text-secondary lg:table-cell">
                            {typeLabel}
                          </TableCell>
                          <TableCell className="min-w-0 max-w-0 font-medium">
                            <div className="min-w-0">
                              <TruncatedTableText
                                value={assetLabel}
                                className="block max-w-full truncate"
                              />
                              <div className="mt-1 text-xs font-normal text-tertiary lg:hidden">
                                <span>{directionLabel}</span>
                                <span className="mx-1.5">·</span>
                                <span>{createdLabel}</span>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="hidden text-secondary lg:table-cell">
                            {directionLabel}
                          </TableCell>
                          <TableCell className="hidden min-w-0 max-w-0 text-secondary xl:table-cell">
                            <TruncatedTableText
                              value={counterparty}
                              className="block max-w-full truncate"
                            />
                          </TableCell>
                          <TableCell className="hidden min-w-0 max-w-0 font-mono text-xs 2xl:table-cell">
                            {transfer.signature ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <a
                                    href={getDevnetExplorerUrl(transfer.signature)}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="flex min-w-0 max-w-full items-center gap-1 text-primary underline underline-offset-2"
                                  >
                                    <span className="block min-w-0 max-w-full truncate">
                                      {truncateHash(transfer.signature)}
                                    </span>
                                    <ExternalLink className="size-3 shrink-0" />
                                  </a>
                                </TooltipTrigger>
                                <TooltipContent
                                  side="top"
                                  align="start"
                                  className="max-w-[32rem] break-all text-xs"
                                >
                                  {transfer.signature}
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="text-tertiary">
                                {t("DashboardPayments.pending")}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="hidden text-secondary lg:table-cell">
                            {createdLabel}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TooltipProvider>
            )}
          </CardContent>
        </Card>
      </SectionEntry>
    </div>
  );
}
