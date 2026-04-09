"use client";

import { CreateApiKeyModal } from "@/app/dashboard/api-keys/create-api-key-modal";
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
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import type { PaymentsDashboardWallet } from "@sdp/types";
import Link from "next/link";
import type { HomeActivityRow } from "./home-page.data";
import { fetchHomeActivity } from "./home-workspace.data";
import { formatCurrencyAmount, formatDisplayAmount } from "./payments/payments-overview.utils";

interface HomeWorkspaceProps {
  totalBalance: number | null;
  totalBalanceError: string | null;
  wallets: PaymentsDashboardWallet[];
}

interface HomeWorkspaceActivityState {
  isWalletEmptyState: boolean;
  totalBalanceHint: string | null;
  todaysVolume: number | null;
  todaysVolumeError: string | null;
  todaysVolumeHint: string | null;
  activityError: string | null;
  activityRows: HomeActivityRow[];
  activityNotice: string | null;
  emptyActivityMessage: string;
}

const HOME_ACTIVITY_KEY = "dashboard-home-activity";
const HOME_ACTIVITY_CACHE_TTL_MS = 60_000;

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
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

function MetricCard({
  label,
  value,
  error,
  hint,
}: {
  label: string;
  value: number | null;
  error: string | null;
  hint?: string | null;
}) {
  const showUnavailableState = error !== null && value === null;

  return (
    <Card className="gap-0 rounded-[18px] border-[rgba(28,28,29,0.1)] py-0 shadow-none">
      <CardContent className="space-y-2 px-6 py-6">
        <p className="text-[15px] text-[rgba(28,28,29,0.56)]">{label}</p>
        <p className="text-[24px] leading-none font-medium tracking-[-0.03em] text-[#1c1c1d] sm:text-[30px]">
          {showUnavailableState ? "Unavailable" : formatCurrencyAmount(value)}
        </p>
        {showUnavailableState ? <p className="text-sm text-[#9e2b38]">{error}</p> : null}
        {!showUnavailableState && hint ? (
          <p className="text-sm text-[rgba(28,28,29,0.56)]">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function resolveActivityRequestError(error: unknown): string | null {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Activity is unavailable right now.";
}

function buildHomeWorkspaceActivityState(
  wallets: PaymentsDashboardWallet[],
  totalBalance: number | null,
  activitySnapshot: Awaited<ReturnType<typeof fetchHomeActivity>> | undefined,
  activityRequestError: unknown
): HomeWorkspaceActivityState {
  const isWalletEmptyState = wallets.length === 0;
  const requestError = resolveActivityRequestError(activityRequestError);
  const todaysVolume = activitySnapshot?.todaysVolume ?? null;
  const activityError = requestError ?? activitySnapshot?.activityError ?? null;

  return {
    isWalletEmptyState,
    totalBalanceHint: isWalletEmptyState
      ? "Create your first wallet to start tracking balances."
      : totalBalance === null
        ? "No tracked balances found yet."
        : null,
    todaysVolume,
    todaysVolumeError:
      todaysVolume !== null ? null : (requestError ?? activitySnapshot?.activityError ?? null),
    todaysVolumeHint: isWalletEmptyState
      ? "Payment activity will appear after you create a wallet."
      : todaysVolume === null
        ? activitySnapshot
          ? "No payment volume recorded yet."
          : "Loading payment activity..."
        : todaysVolume === 0
          ? "No payment volume recorded yet."
          : null,
    activityError,
    activityRows: activitySnapshot?.activityRows ?? [],
    activityNotice: activitySnapshot?.activityNotice ?? null,
    emptyActivityMessage: isWalletEmptyState
      ? "Create your first wallet to start tracking balances and activity."
      : activitySnapshot
        ? "No recent activity found yet."
        : "Loading recent activity...",
  };
}

export function HomeWorkspace({ totalBalance, totalBalanceError, wallets }: HomeWorkspaceProps) {
  const { dashboardAccess } = useDashboardWorkspace();
  const { data: activitySnapshot, error: activityRequestError } = usePersistedDashboardSWR(
    HOME_ACTIVITY_KEY,
    () => fetchHomeActivity(),
    {
      revalidateOnFocus: true,
      refreshInterval: 20_000,
    },
    {
      key: "home-activity",
      ttlMs: HOME_ACTIVITY_CACHE_TTL_MS,
    }
  );
  const {
    totalBalanceHint,
    todaysVolume,
    todaysVolumeError,
    todaysVolumeHint,
    activityError,
    activityRows,
    activityNotice,
    emptyActivityMessage,
  } = buildHomeWorkspaceActivityState(
    wallets,
    totalBalance,
    activitySnapshot,
    activityRequestError
  );

  return (
    <div className="w-full space-y-8 py-2">
      <SectionEntry>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {dashboardAccess.capabilities.canManageApiKeys ? (
            <CreateApiKeyModal
              triggerLabel="Create API key"
              triggerVariant="secondary"
              wallets={wallets}
            />
          ) : null}
          {dashboardAccess.capabilities.canManageCustody ? (
            <Button asChild>
              <Link href="/dashboard/wallets">Create Wallet</Link>
            </Button>
          ) : null}
        </div>
      </SectionEntry>

      <SectionEntry delay={0.04}>
        <div className="grid gap-4 md:grid-cols-2">
          <MetricCard
            label="Total Balance"
            value={totalBalance}
            error={totalBalanceError}
            hint={totalBalanceHint}
          />
          <MetricCard
            label="Today's Volume"
            value={todaysVolume}
            error={todaysVolumeError}
            hint={todaysVolumeHint}
          />
        </div>
      </SectionEntry>

      <SectionEntry delay={0.08}>
        <div className="space-y-4">
          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <CardTitle>Recent transactions</CardTitle>
                {activityNotice ? (
                  <CardDescription>{activityNotice}</CardDescription>
                ) : (
                  <CardDescription>
                    Latest wallet and issuance activity across the organization.
                  </CardDescription>
                )}
              </div>
              <Button asChild variant="secondary" size="sm">
                <Link href="/dashboard/payments">See all payments</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {activityError ? (
                <p className="text-sm text-[#9e2b38]">{activityError}</p>
              ) : activityRows.length === 0 ? (
                <p className="text-sm text-[rgba(28,28,29,0.72)]">{emptyActivityMessage}</p>
              ) : (
                <TooltipProvider>
                  <div className="min-w-0">
                    <Table className="table-fixed">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[8rem] pl-6">Time</TableHead>
                          <TableHead className="w-[calc(100%-8rem)] md:hidden">Activity</TableHead>
                          <TableHead className="hidden w-[10rem] md:table-cell">Type</TableHead>
                          <TableHead className="hidden w-[8rem] md:table-cell">Token</TableHead>
                          <TableHead className="hidden w-[10rem] md:table-cell">Amount</TableHead>
                          <TableHead className="hidden pr-6 md:table-cell">Address</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {activityRows.map((row) => {
                          const timeLabel = formatRelativeTime(row.createdAt);
                          const amountLabel =
                            row.amount === "—" ? "—" : formatDisplayAmount(row.amount, row.token);

                          return (
                            <TableRow key={row.id}>
                              <TableCell className="pl-6 text-[rgba(28,28,29,0.72)]">
                                {timeLabel}
                              </TableCell>
                              <TableCell className="min-w-0 md:hidden">
                                <div className="min-w-0">
                                  <div className="truncate font-medium">{row.type}</div>
                                  <div className="mt-1 truncate text-xs text-[rgba(28,28,29,0.56)]">
                                    {amountLabel}
                                  </div>
                                  <TruncatedTableText
                                    value={row.address}
                                    className="mt-1 truncate font-mono text-xs text-[rgba(28,28,29,0.56)]"
                                  />
                                </div>
                              </TableCell>
                              <TableCell className="hidden font-medium md:table-cell">
                                {row.type}
                              </TableCell>
                              <TableCell className="hidden text-[rgba(28,28,29,0.78)] md:table-cell">
                                <TruncatedTableText value={row.token} className="truncate" />
                              </TableCell>
                              <TableCell className="hidden text-[rgba(28,28,29,0.78)] md:table-cell">
                                <TruncatedTableText value={amountLabel} className="truncate" />
                              </TableCell>
                              <TableCell className="hidden pr-6 font-mono text-xs text-[rgba(28,28,29,0.72)] md:table-cell">
                                <TruncatedTableText value={row.address} className="truncate" />
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
        </div>
      </SectionEntry>
    </div>
  );
}
