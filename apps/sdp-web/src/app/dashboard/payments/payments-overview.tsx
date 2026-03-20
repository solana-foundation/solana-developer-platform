"use client";

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
import type { CustodyWalletAggregate, PaymentTransferSummary as TransferRecord } from "@sdp/types";
import { ArrowDownLeft, ArrowUpRight, ExternalLink, RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import useSWR from "swr";
import {
  formatCurrencyAmount,
  formatDirection,
  formatDisplayAmount,
  formatTimestamp,
  resolveAggregateBalanceDisplayToken,
  resolveCounterparty,
  resolveTotalBalance,
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
  transfers: TransferRecord[];
  transfersError: string | null;
}

const PAYMENTS_OVERVIEW_AGGREGATE_KEY = "payments-overview-aggregate";
const PAYMENTS_OVERVIEW_TRANSFERS_KEY = "payments-overview-transfers";

function statusClassName(status: string): string {
  switch (status.toLowerCase()) {
    case "confirmed":
    case "finalized":
      return "border-[rgba(17,94,61,0.18)] bg-[rgba(16,185,129,0.1)] text-[#115e3d]";
    case "processing":
    case "pending":
      return "border-[rgba(180,83,9,0.22)] bg-[rgba(245,158,11,0.12)] text-[#8a5a00]";
    case "failed":
      return "border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.08)] text-[#9e2b38]";
    default:
      return "border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.05)] text-[rgba(28,28,29,0.72)]";
  }
}

function resolveRequestError(error: unknown, fallback: string | null): string | null {
  if (error instanceof Error) {
    return error.message;
  }

  if (error) {
    return "Request failed.";
  }

  return fallback;
}

function TruncatedTableText({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
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

export function PaymentsOverview({
  aggregate,
  aggregateError,
  issuedTokenSymbolsByMint,
  transfers,
  transfersError,
}: PaymentsOverviewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const refreshSeed = searchParams.get("refresh") ?? "default";
  const {
    data: swrAggregate,
    error: aggregateFetchError,
    isValidating: aggregateRefreshing,
    mutate: mutateAggregate,
  } = useSWR<CustodyWalletAggregate>(
    [PAYMENTS_OVERVIEW_AGGREGATE_KEY, refreshSeed],
    () => fetchWalletAggregate(),
    {
      fallbackData: aggregateError || !aggregate ? undefined : aggregate,
      revalidateOnFocus: true,
      refreshInterval: 30_000,
    }
  );
  const {
    data: swrTransfers,
    error: transfersFetchError,
    isValidating: transfersRefreshing,
    mutate: mutateTransfers,
  } = useSWR<TransferRecord[]>(
    [PAYMENTS_OVERVIEW_TRANSFERS_KEY, refreshSeed],
    () => fetchTransfers(),
    {
      fallbackData: transfersError ? undefined : transfers,
      revalidateOnFocus: true,
      refreshInterval: 10_000,
    }
  );

  const liveAggregate = swrAggregate ?? aggregate;
  const liveTransfers = swrTransfers ?? transfers;
  const liveAggregateError = aggregateFetchError
    ? resolveRequestError(aggregateFetchError, aggregateError)
    : swrAggregate === undefined
      ? aggregateError
      : null;
  const liveTransfersError = transfersFetchError
    ? resolveRequestError(transfersFetchError, transfersError)
    : swrTransfers === undefined
      ? transfersError
      : null;
  const isRefreshing = aggregateRefreshing || transfersRefreshing;
  const aggregateBalances = useMemo(() => liveAggregate?.balances ?? [], [liveAggregate]);
  const topAggregateBalances = useMemo(
    () => selectTopAggregateBalanceRows(aggregateBalances, issuedTokenSymbolsByMint),
    [aggregateBalances, issuedTokenSymbolsByMint]
  );
  const totalBalance = resolveTotalBalance(aggregateBalances);
  const walletCount = liveAggregate?.walletCount ?? 0;
  const hasWallets = walletCount > 0;

  const handleRefresh = () => {
    void Promise.all([mutateAggregate(), mutateTransfers()]);
  };

  return (
    <div className="grid min-w-0 gap-6 overflow-x-hidden">
      <SectionEntry>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Button
            type="button"
            className="rounded-full px-5"
            disabled={!hasWallets}
            onClick={() => router.push("/dashboard/payments/send")}
          >
            <ArrowUpRight className="size-4" />
            Send
          </Button>
          <Button
            type="button"
            className="rounded-full px-5"
            disabled={!hasWallets}
            onClick={() => router.push("/dashboard/payments/receive")}
          >
            <ArrowDownLeft className="size-4" />
            Receive
          </Button>
        </div>
      </SectionEntry>

      <SectionEntry delay={0.04}>
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,1fr)]">
          <div className="flex min-h-[244px] flex-col justify-center rounded-[4px] bg-[rgba(28,28,29,0.04)] px-8 py-10 sm:px-14">
            <div className="space-y-3">
              <p className="text-[15px] font-medium tracking-[0.01em] text-[#1c1c1d]">
                Total SDP balance
              </p>
              <p className="text-[38px] leading-none font-medium tracking-[-0.05em] text-[#1c1c1d] sm:text-[54px]">
                {formatCurrencyAmount(totalBalance)}
              </p>
              <p className="text-sm text-[rgba(28,28,29,0.56)]">
                Aggregated across {walletCount} {walletCount === 1 ? "wallet" : "wallets"}.
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
                    className="flex min-h-[78px] min-w-0 items-center justify-between gap-4 overflow-hidden rounded-[4px] bg-[rgba(28,28,29,0.04)] px-6 py-5"
                  >
                    <p
                      className="min-w-0 truncate text-[18px] font-medium tracking-[0.04em] text-[#1c1c1d] uppercase"
                      title={displayToken}
                    >
                      {displayToken}
                    </p>
                    <p
                      className="min-w-0 max-w-[40%] truncate text-right text-[18px] font-medium tracking-[0.01em] text-[#1c1c1d] sm:text-[20px]"
                      title={formatCurrencyAmount(usdValue)}
                    >
                      {formatCurrencyAmount(usdValue)}
                    </p>
                  </div>
                );
              })
            ) : (
              <div className="flex min-h-[78px] items-center rounded-[4px] bg-[rgba(28,28,29,0.04)] px-6 py-5 text-sm text-[rgba(28,28,29,0.64)]">
                No USD-valued asset rows available yet.
              </div>
            )}
          </div>
        </div>

        {liveAggregateError ? (
          <p className="mt-4 text-sm text-[#9e2b38]">{liveAggregateError}</p>
        ) : null}
      </SectionEntry>

      <SectionEntry delay={0.08}>
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <CardTitle>Recent transactions</CardTitle>
              <CardDescription className="hidden sm:block">
                Latest transfer activity across all organization wallets.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="hidden sm:inline-flex"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`size-4 ${isRefreshing ? "animate-spin" : ""}`} />
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </Button>
          </CardHeader>
          <CardContent>
            {liveTransfersError ? (
              <p className="text-sm text-[#9e2b38]">{liveTransfersError}</p>
            ) : liveTransfers.length === 0 ? (
              <p className="text-sm text-[rgba(28,28,29,0.72)]">No transactions found yet.</p>
            ) : (
              <TooltipProvider>
                <div className="min-w-0">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[9rem]">Status</TableHead>
                        <TableHead className="w-[calc(100%-9rem)] md:w-[22%]">
                          <span className="md:hidden">Transfer</span>
                          <span className="hidden md:inline">Asset</span>
                        </TableHead>
                        <TableHead className="hidden w-[8rem] md:table-cell">Direction</TableHead>
                        <TableHead className="hidden w-[26%] md:table-cell">Counterparty</TableHead>
                        <TableHead className="hidden w-[22%] md:table-cell">Signature</TableHead>
                        <TableHead className="hidden w-[10rem] md:table-cell">Created</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {liveTransfers.map((transfer) => {
                        const counterparty = resolveCounterparty(transfer);
                        const assetLabel = formatDisplayAmount(transfer.amount, transfer.token);
                        const directionLabel = formatDirection(transfer.direction);
                        const createdLabel = formatTimestamp(transfer.createdAt);

                        return (
                          <TableRow key={transfer.id}>
                            <TableCell>
                              <span
                                className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClassName(transfer.status)}`}
                              >
                                {transfer.status}
                              </span>
                            </TableCell>
                            <TableCell className="min-w-0 font-medium">
                              <div className="min-w-0">
                                <TruncatedTableText value={assetLabel} className="truncate" />
                                <div className="mt-1 text-xs font-normal text-[rgba(28,28,29,0.56)] md:hidden">
                                  <span>{directionLabel}</span>
                                  <span className="mx-1.5">·</span>
                                  <span>{createdLabel}</span>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="hidden text-[rgba(28,28,29,0.72)] md:table-cell">
                              {directionLabel}
                            </TableCell>
                            <TableCell className="hidden min-w-0 font-mono text-xs text-[rgba(28,28,29,0.72)] md:table-cell">
                              <TruncatedTableText value={counterparty} className="truncate" />
                            </TableCell>
                            <TableCell className="hidden min-w-0 font-mono text-xs md:table-cell">
                              {transfer.signature ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <a
                                      href={getDevnetExplorerUrl(transfer.signature)}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="flex min-w-0 items-center gap-1 text-[#1c1c1d] underline underline-offset-2"
                                    >
                                      <span className="block min-w-0 truncate">
                                        {transfer.signature}
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
                                <span className="text-[rgba(28,28,29,0.52)]">Pending</span>
                              )}
                            </TableCell>
                            <TableCell className="hidden text-[rgba(28,28,29,0.72)] md:table-cell">
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
      </SectionEntry>
    </div>
  );
}
