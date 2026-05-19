"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
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
import { formatDisplayAmount } from "../payments/payments-overview.utils";

interface WalletActivitySectionProps {
  walletId: string;
  initialActivity: WalletActivityPayload;
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

export function WalletActivitySection({ walletId, initialActivity }: WalletActivitySectionProps) {
  const {
    data: swrActivity,
    error: requestError,
    isValidating,
    mutate,
  } = useSWR(`wallet-activity-${walletId}`, () => fetchWalletActivity(walletId), {
    fallbackData: initialActivity,
    revalidateOnFocus: true,
    refreshInterval: 20_000,
  });
  const liveActivity = swrActivity ?? initialActivity;
  const liveRows = Array.isArray(liveActivity.activityRows) ? liveActivity.activityRows : [];
  const requestErrorMessage = requestError
    ? requestError instanceof Error
      ? requestError.message
      : "Unable to load wallet activity."
    : null;
  const liveActivityError =
    requestErrorMessage && liveRows.length === 0 ? requestErrorMessage : liveActivity.activityError;
  const liveActivityNotice =
    requestErrorMessage && liveRows.length > 0 ? requestErrorMessage : liveActivity.activityNotice;

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>Transfer and token operation activity for this wallet.</CardDescription>
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
        {liveActivityError ? (
          <p className="text-sm text-[#9e2b38]">{liveActivityError}</p>
        ) : liveRows.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-[rgba(28,28,29,0.72)]">No wallet activity found yet.</p>
            {liveActivityNotice ? (
              <p className="text-xs text-[rgba(28,28,29,0.56)]">{liveActivityNotice}</p>
            ) : null}
          </div>
        ) : (
          <TooltipProvider>
            <div className="min-w-0 space-y-3">
              {liveActivityNotice ? (
                <p className="text-xs text-[rgba(28,28,29,0.56)]">{liveActivityNotice}</p>
              ) : null}
              <Table className="[&_table]:table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[9rem]">Status</TableHead>
                    <TableHead className="w-[calc(100%-9rem)] md:w-[22%]">
                      <span className="md:hidden">Activity</span>
                      <span className="hidden md:inline">Asset</span>
                    </TableHead>
                    <TableHead className="hidden w-[8rem] md:table-cell">Direction</TableHead>
                    <TableHead className="hidden w-[26%] md:table-cell">Counterparty</TableHead>
                    <TableHead className="hidden w-[22%] md:table-cell">Signature</TableHead>
                    <TableHead className="hidden w-[10rem] md:table-cell">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {liveRows.map((row: WalletActivityRow) => {
                    const assetLabel =
                      row.amount && row.token
                        ? formatDisplayAmount(row.amount, row.token)
                        : (row.token ?? "Unknown asset");
                    const createdLabel = formatTimestamp(row.createdAt);
                    const address = row.address ?? "Unknown";

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
                            <div className="mt-1 text-xs font-normal text-[rgba(28,28,29,0.56)] md:hidden">
                              <span>{row.operationLabel}</span>
                              <span className="mx-1.5">·</span>
                              <span>{createdLabel}</span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden text-[rgba(28,28,29,0.72)] md:table-cell">
                          {row.operationLabel}
                        </TableCell>
                        <TableCell className="hidden min-w-0 font-mono text-xs text-[rgba(28,28,29,0.72)] md:table-cell">
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
                                  className="flex min-w-0 items-center gap-1 text-[#1c1c1d] underline underline-offset-2"
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
