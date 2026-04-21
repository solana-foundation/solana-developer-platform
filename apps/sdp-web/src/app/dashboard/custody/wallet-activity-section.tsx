"use client";

import type { PaymentTransferSummary as TransferRecord } from "@sdp/types";
import { ExternalLink, RefreshCw } from "lucide-react";
import {
  fetchTransfers,
  getDevnetExplorerUrl,
} from "@/app/dashboard/payments/payments-workspace.data";
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
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { formatDisplayAmount } from "../payments/payments-overview.utils";

const WALLET_ACTIVITY_CACHE_TTL_MS = 20_000;

interface WalletActivitySectionProps {
  walletId: string;
  initialTransfers: TransferRecord[];
  initialTransfersError: string | null;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDirection(value: string | undefined): string {
  if (value === "inbound") {
    return "Incoming";
  }
  if (value === "outbound") {
    return "Outgoing";
  }
  return "Transfer";
}

function resolveCounterparty(transfer: TransferRecord): string {
  if (transfer.direction === "inbound") {
    return transfer.source ?? "Unknown source";
  }

  if (transfer.direction === "outbound") {
    return transfer.destination ?? "Unknown destination";
  }

  return transfer.destination ?? transfer.source ?? "Unknown";
}

function statusClassName(status: string): string {
  if (status === "confirmed") {
    return "border-[rgba(12,128,76,0.18)] bg-[rgba(12,128,76,0.08)] text-[#0c804c]";
  }

  if (status === "failed") {
    return "border-[rgba(199,31,55,0.16)] bg-[rgba(199,31,55,0.08)] text-[#9e2b38]";
  }

  return "border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] text-[rgba(28,28,29,0.72)]";
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

export function WalletActivitySection({
  walletId,
  initialTransfers,
  initialTransfersError,
}: WalletActivitySectionProps) {
  const {
    data: swrTransfers,
    error: requestError,
    isValidating,
    mutate,
  } = usePersistedDashboardSWR(
    `wallet-activity-${walletId}`,
    () => fetchTransfers({ walletId }),
    {
      fallbackData: initialTransfersError ? undefined : initialTransfers,
      revalidateOnFocus: true,
      refreshInterval: 20_000,
    },
    {
      key: `wallet-activity.${walletId}`,
      ttlMs: WALLET_ACTIVITY_CACHE_TTL_MS,
    }
  );
  const liveTransfers = swrTransfers ?? initialTransfers;
  const liveTransfersError = requestError
    ? requestError instanceof Error
      ? requestError.message
      : "Unable to load wallet activity."
    : swrTransfers === undefined
      ? initialTransfersError
      : null;

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            Incoming and outgoing transfer activity for this wallet.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void mutate()}
          disabled={isValidating}
        >
          <RefreshCw className={`size-4 ${isValidating ? "animate-spin" : ""}`} />
          {isValidating ? "Refreshing..." : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent>
        {liveTransfersError ? (
          <p className="text-sm text-[#9e2b38]">{liveTransfersError}</p>
        ) : liveTransfers.length === 0 ? (
          <p className="text-sm text-[rgba(28,28,29,0.72)]">No wallet activity found yet.</p>
        ) : (
          <TooltipProvider>
            <div className="min-w-0">
              <Table className="[&_table]:table-fixed">
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
                    const assetLabel =
                      transfer.amount && transfer.token
                        ? formatDisplayAmount(transfer.amount, transfer.token)
                        : (transfer.token ?? "Unknown asset");
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
                            <TruncatedText value={assetLabel} className="truncate" />
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
                          <TruncatedText value={counterparty} className="truncate" />
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
  );
}
