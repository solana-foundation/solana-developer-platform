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
import type {
  CustodyWalletAggregate,
  PaymentTransferSummary as TransferRecord,
  PaymentsDashboardWallet as WalletRecord,
} from "@sdp/types";
import { ArrowDownLeft, ArrowUpRight, ExternalLink, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import useSWR from "swr";
import {
  formatCurrencyAmount,
  formatDirection,
  formatDisplayAmount,
  formatTimestamp,
  resolveAggregateBalanceRows,
  resolveCounterparty,
  resolveTotalBalance,
} from "./payments-overview.utils";
import {
  fetchTransfers,
  fetchWalletAggregate,
  fetchWallets,
  getDevnetExplorerUrl,
} from "./payments-workspace.data";

interface PaymentsOverviewProps {
  wallets: WalletRecord[];
  walletsError: string | null;
  aggregate: CustodyWalletAggregate | null;
  aggregateError: string | null;
  transfers: TransferRecord[];
  transfersError: string | null;
}

const PAYMENTS_OVERVIEW_WALLETS_KEY = "payments-overview-wallets";
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

export function PaymentsOverview({
  wallets,
  walletsError,
  aggregate,
  aggregateError,
  transfers,
  transfersError,
}: PaymentsOverviewProps) {
  const router = useRouter();
  const {
    data: swrWallets,
    error: walletsFetchError,
    isValidating: walletsRefreshing,
    mutate: mutateWallets,
  } = useSWR<WalletRecord[]>(PAYMENTS_OVERVIEW_WALLETS_KEY, () => fetchWallets(), {
    fallbackData: walletsError ? undefined : wallets,
    revalidateOnFocus: true,
    refreshInterval: 30_000,
  });
  const {
    data: swrAggregate,
    error: aggregateFetchError,
    isValidating: aggregateRefreshing,
    mutate: mutateAggregate,
  } = useSWR<CustodyWalletAggregate>(
    PAYMENTS_OVERVIEW_AGGREGATE_KEY,
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
  } = useSWR<TransferRecord[]>(PAYMENTS_OVERVIEW_TRANSFERS_KEY, () => fetchTransfers(), {
    fallbackData: transfersError ? undefined : transfers,
    revalidateOnFocus: true,
    refreshInterval: 10_000,
  });

  const liveWallets = swrWallets ?? wallets;
  const liveAggregate = swrAggregate ?? aggregate;
  const liveTransfers = swrTransfers ?? transfers;
  const liveWalletsError = walletsFetchError
    ? resolveRequestError(walletsFetchError, walletsError)
    : swrWallets === undefined
      ? walletsError
      : null;
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
  const isRefreshing = walletsRefreshing || aggregateRefreshing || transfersRefreshing;
  const aggregateBalances = useMemo(
    () => resolveAggregateBalanceRows(liveAggregate, liveWallets),
    [liveAggregate, liveWallets]
  );
  const totalBalance = resolveTotalBalance(aggregateBalances);
  const hasWallets = liveWallets.length > 0;
  const walletCount = liveAggregate?.walletCount ?? liveWallets.length;

  const handleRefresh = () => {
    void Promise.all([mutateWallets(), mutateAggregate(), mutateTransfers()]);
  };

  return (
    <div className="grid gap-6">
      <SectionEntry>
        <div className="flex flex-wrap items-center gap-3">
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
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,1fr)]">
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

          <div className="grid gap-1.5">
            {aggregateBalances.length > 0 ? (
              aggregateBalances.map((balance) => (
                <div
                  key={`${balance.token}-${balance.mint}`}
                  className="flex min-h-[78px] items-center justify-between gap-4 rounded-[4px] bg-[rgba(28,28,29,0.04)] px-6 py-5"
                >
                  <p className="text-[18px] font-medium tracking-[0.04em] text-[#1c1c1d] uppercase">
                    {balance.token}
                  </p>
                  <p className="text-right text-[18px] font-medium tracking-[0.01em] text-[#1c1c1d] sm:text-[20px]">
                    {formatCurrencyAmount(balance.uiAmount)}
                  </p>
                </div>
              ))
            ) : (
              <div className="flex min-h-[78px] items-center rounded-[4px] bg-[rgba(28,28,29,0.04)] px-6 py-5 text-sm text-[rgba(28,28,29,0.64)]">
                No aggregated balance rows available yet.
              </div>
            )}
          </div>
        </div>

        {liveWalletsError ? (
          <p className="mt-4 text-sm text-[#9e2b38]">{liveWalletsError}</p>
        ) : null}
        {liveAggregateError ? (
          <p className="mt-2 text-sm text-[#9e2b38]">{liveAggregateError}</p>
        ) : null}
      </SectionEntry>

      <SectionEntry delay={0.08}>
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <CardTitle>Recent transactions</CardTitle>
              <CardDescription>
                Latest transfer activity across all organization wallets.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="secondary"
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
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead>Counterparty</TableHead>
                      <TableHead>Signature</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {liveTransfers.map((transfer) => {
                      const counterparty = resolveCounterparty(transfer);

                      return (
                        <TableRow key={transfer.id}>
                          <TableCell>
                            <span
                              className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClassName(transfer.status)}`}
                            >
                              {transfer.status}
                            </span>
                          </TableCell>
                          <TableCell className="text-[rgba(28,28,29,0.72)]">
                            {formatDirection(transfer.direction)}
                          </TableCell>
                          <TableCell className="font-medium">
                            {formatDisplayAmount(transfer.amount, transfer.token)}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-[rgba(28,28,29,0.72)]">
                            <div
                              className="max-w-[12rem] truncate sm:max-w-[18rem]"
                              title={counterparty}
                            >
                              {counterparty}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {transfer.signature ? (
                              <a
                                href={getDevnetExplorerUrl(transfer.signature)}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[#1c1c1d] underline underline-offset-2"
                                title={transfer.signature}
                              >
                                <span className="max-w-[9rem] truncate sm:max-w-[12rem]">
                                  {transfer.signature}
                                </span>
                                <ExternalLink className="size-3" />
                              </a>
                            ) : (
                              <span className="text-[rgba(28,28,29,0.52)]">Pending</span>
                            )}
                          </TableCell>
                          <TableCell className="text-[rgba(28,28,29,0.72)]">
                            {formatTimestamp(transfer.createdAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </SectionEntry>
    </div>
  );
}
