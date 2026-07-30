"use client";

import type { CustodyWalletTokenBalance, PaymentsDashboardWallet, SolanaCluster } from "@sdp/types";
import { ExternalLink } from "lucide-react";
import { CreateApiKeyModal } from "@/app/dashboard/api-keys/create-api-key-modal";
import { SectionEntry } from "@/app/dashboard/wallets/section-entry";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
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
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "./activity-format-utils";
import { buildHomeBalanceBreakdown, countHeldTokens } from "./home-balance-breakdown";
import type { HomeActivityExplorerRef, HomeActivityRow } from "./home-page.data";
import { fetchHomeActivity } from "./home-workspace.data";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  resolveTransferTokenLabel,
} from "./payments/payments-overview.utils";

interface HomeWorkspaceProps {
  totalBalance: number | null;
  totalBalanceError: string | null;
  wallets: PaymentsDashboardWallet[];
  balances: CustodyWalletTokenBalance[];
  walletCount: number;
}

const HOME_ACTIVITY_KEY = "dashboard-home-activity";
const HOME_ACTIVITY_CACHE_TTL_MS = 60_000;

function TruncatedTableText({ value, className }: { value: string; className?: string }) {
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

function explorerHref(ref: HomeActivityExplorerRef, cluster: SolanaCluster): string {
  return ref.kind === "tx"
    ? explorerTxUrl(ref.value, cluster)
    : explorerAddressUrl(ref.value, cluster);
}

/** Renders the activity address, linked to Solana Explorer on the active cluster when linkable. */
function ActivityAddress({
  row,
  cluster,
  className,
}: {
  row: HomeActivityRow;
  cluster: SolanaCluster;
  className?: string;
}) {
  if (!row.explorer) {
    return <TruncatedTableText value={row.address} className={className} />;
  }
  return (
    <a
      href={explorerHref(row.explorer, cluster)}
      target="_blank"
      rel="noreferrer"
      className="flex min-w-0 max-w-full items-center gap-1 text-primary underline underline-offset-2"
    >
      <TruncatedTableText value={row.address} className={`min-w-0 ${className ?? "truncate"}`} />
      <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

function MetricCard({
  label,
  value,
  error,
  hint,
  /**
   * Counts are plain integers, not money — `formatCurrencyAmount` would render a
   * wallet count as "$3.00".
   */
  kind = "currency",
}: {
  label: string;
  value: number | null;
  error: string | null;
  hint?: string | null;
  kind?: "currency" | "count";
}) {
  const t = useTranslations();
  const locale = useLocale();
  const display =
    kind === "count" ? (value ?? 0).toLocaleString(locale) : formatCurrencyAmount(value, locale);
  return (
    <Card className="gap-0 rounded-[18px] py-0 shadow-none">
      <CardContent className="space-y-2 px-6 py-6">
        <p className="text-[15px] text-tertiary">{label}</p>
        <p className="text-[24px] leading-none font-medium tracking-[-0.03em] text-primary sm:text-[30px]">
          {error ? t("Shared.homeWorkspace.unavailable") : display}
        </p>
        {error ? <p className="text-sm text-destructive-strong">{error}</p> : null}
        {!error && hint ? <p className="text-sm text-tertiary">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * Descending emphasis for descending share. The design system ships no categorical
 * chart palette, and a stacked allocation bar is a magnitude encoding rather than an
 * identity one, so a single neutral ramp is the right job — and it re-steps itself
 * per theme instead of needing a hand-picked dark variant.
 */
const ALLOCATION_FILLS = [
  "bg-primary",
  "bg-secondary",
  "bg-tertiary",
  "bg-muted",
  "bg-fill-strong",
] as const;

function allocationFill(index: number): string {
  return ALLOCATION_FILLS[Math.min(index, ALLOCATION_FILLS.length - 1)];
}

/**
 * Holdings by token. The aggregate already returns the per-token rows the total is
 * summed from, so this needs no extra request.
 *
 * Priced holdings compose one stacked allocation bar; unpriced ones are listed below
 * it without a bar. An organization's own issued tokens have no price feed, and the
 * first version drew a share bar for every row — the unpriced ones rendered as empty
 * full-width rules that read as dividers, and comparing a raw token count against a
 * dollar amount was meaningless anyway.
 */
function BalanceBreakdownCard({
  balances,
  locale,
}: {
  balances: CustodyWalletTokenBalance[];
  locale: string;
}) {
  const t = useTranslations();
  const breakdown = buildHomeBalanceBreakdown(balances);
  if (breakdown.priced.length === 0 && breakdown.unpriced.length === 0) {
    return null;
  }

  // Balances carry their own symbols, so tokens the catalogue has never heard of
  // still get named rather than falling back to a shortened mint.
  const symbolsByMint = Object.fromEntries(
    balances.map((balance) => [balance.mint, balance.token])
  );
  const symbolFor = (slice: { mint: string; token: string }) =>
    resolveTransferTokenLabel(slice.mint, symbolsByMint) ?? slice.token;

  const segments = [
    ...breakdown.priced.map((slice, index) => ({
      key: slice.mint,
      label: symbolFor(slice),
      percent: slice.sharePercent,
      value: slice.usdValue ?? 0,
      fill: allocationFill(index),
    })),
    ...(breakdown.otherPricedCount > 0
      ? [
          {
            key: "__other__",
            label: t("Shared.homeWorkspace.otherTokens", {
              count: breakdown.otherPricedCount,
            }),
            percent: breakdown.otherPricedSharePercent,
            value: breakdown.otherPricedUsd,
            fill: allocationFill(breakdown.priced.length),
          },
        ]
      : []),
  ];

  return (
    <Card className="min-w-0 gap-0 rounded-[18px] py-0 shadow-none">
      <CardContent className="space-y-5 px-6 py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-[15px] text-tertiary">{t("Shared.homeWorkspace.balanceByToken")}</p>
          {breakdown.totalUsd !== null ? (
            <p className="text-[15px] font-medium text-primary tabular-nums">
              {formatCurrencyAmount(breakdown.totalUsd, locale)}
            </p>
          ) : null}
        </div>

        {segments.length > 0 ? (
          <>
            {/* One bar, segmented — the numbers beside each label are the accessible
                values, so the bar itself is decoration. gap-0.5 is the 2px spacer
                that keeps adjacent fills from reading as a single block. */}
            <div aria-hidden="true" className="flex h-2 w-full gap-0.5 overflow-hidden">
              {segments.map((segment) => (
                <div
                  key={segment.key}
                  className={cn("h-full rounded-full", segment.fill)}
                  style={{ width: `${Math.max(segment.percent, 1.5)}%` }}
                />
              ))}
            </div>

            <ul className="space-y-3">
              {segments.map((segment) => (
                <li key={segment.key} className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={cn("size-2.5 shrink-0 rounded-[3px]", segment.fill)}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                    {segment.label}
                  </span>
                  <span className="shrink-0 text-sm text-tertiary tabular-nums">
                    {Math.round(segment.percent)}%
                  </span>
                  <span className="w-24 shrink-0 text-right text-sm text-secondary tabular-nums">
                    {formatCurrencyAmount(segment.value, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {breakdown.unpriced.length > 0 ? (
          <div className="space-y-3 border-t border-border-default pt-4">
            <p className="text-xs text-tertiary">{t("Shared.homeWorkspace.notPriced")}</p>
            <ul className="space-y-3">
              {breakdown.unpriced.map((slice) => {
                const symbol = symbolFor(slice);
                return (
                  <li key={slice.mint} className="flex min-w-0 items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                      {symbol}
                    </span>
                    <span className="shrink-0 text-sm text-secondary tabular-nums">
                      {formatDisplayAmount(slice.uiAmount, symbol)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Dashboard orchestration keeps related loading, empty, and populated states together.
export function HomeWorkspace({
  totalBalance,
  totalBalanceError,
  wallets,
  balances,
  walletCount,
}: HomeWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const cluster = useSolanaCluster();
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
  const isWalletEmptyState = wallets.length === 0;
  const heldTokenCount = countHeldTokens(balances);
  const totalBalanceHint = isWalletEmptyState
    ? t("Shared.homeWorkspace.createFirstWalletBalances")
    : totalBalance === null
      ? t("Shared.homeWorkspace.noTrackedBalances")
      : null;
  const todaysVolume = activitySnapshot?.todaysVolume ?? null;
  const todaysVolumeError = activityRequestError
    ? activityRequestError instanceof Error
      ? activityRequestError.message || t("Shared.homeWorkspace.activityUnavailable")
      : t("Shared.homeWorkspace.activityUnavailable")
    : (activitySnapshot?.activityError ?? null);
  const activityRows = activitySnapshot?.activityRows ?? [];
  const activityError = activityRequestError
    ? activityRequestError instanceof Error
      ? activityRequestError.message || t("Shared.homeWorkspace.activityUnavailable")
      : t("Shared.homeWorkspace.activityUnavailable")
    : (activitySnapshot?.activityError ?? null);
  const activityNotice = activitySnapshot?.activityNotice ?? null;
  const todaysVolumeHint = isWalletEmptyState
    ? t("Shared.homeWorkspace.paymentActivityAfterWallet")
    : todaysVolume === null
      ? activitySnapshot
        ? t("Shared.homeWorkspace.noPaymentVolume")
        : t("Shared.homeWorkspace.loadingPaymentActivity")
      : null;
  const emptyActivityMessage = isWalletEmptyState
    ? t("Shared.homeWorkspace.createFirstWalletActivity")
    : activitySnapshot
      ? t("Shared.homeWorkspace.noRecentActivity")
      : t("Shared.homeWorkspace.loadingRecentActivity");

  return (
    <div className="w-full space-y-8 py-2">
      <SectionEntry>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {dashboardAccess.capabilities.canManageApiKeys ? (
            <CreateApiKeyModal
              triggerLabel={t("Shared.SharedComponents.createApiKey")}
              triggerVariant="secondary"
            />
          ) : null}
          {dashboardAccess.capabilities.canManageCustody ? (
            <Button
              asChild
              className="!text-on-primary hover:!text-on-primary visited:!text-on-primary"
            >
              <Link href="/dashboard/wallets">{t("Shared.homeWorkspace.createWallet")}</Link>
            </Button>
          ) : null}
        </div>
      </SectionEntry>

      <SectionEntry delay={0.04}>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label={t("Shared.homeWorkspace.totalBalance")}
            value={totalBalance}
            error={totalBalanceError}
            hint={totalBalanceHint}
          />
          <MetricCard
            label={t("Shared.homeWorkspace.todaysVolume")}
            value={todaysVolume}
            error={todaysVolumeError}
            hint={todaysVolumeHint}
          />
          <MetricCard
            label={t("Shared.homeWorkspace.walletsTracked")}
            value={walletCount}
            error={null}
            kind="count"
            // Deliberately not the balances copy the first tile uses — the same
            // sentence twice in one row reads as a rendering bug.
            hint={walletCount === 0 ? t("Shared.homeWorkspace.noWalletsYet") : null}
          />
          <MetricCard
            label={t("Shared.homeWorkspace.tokensHeld")}
            value={heldTokenCount}
            error={totalBalanceError}
            kind="count"
            hint={
              heldTokenCount === 0 && !totalBalanceError
                ? t("Shared.homeWorkspace.noTrackedBalances")
                : null
            }
          />
        </div>
      </SectionEntry>

      {balances.length > 0 ? (
        <SectionEntry delay={0.06}>
          <BalanceBreakdownCard balances={balances} locale={locale} />
        </SectionEntry>
      ) : null}

      <SectionEntry delay={0.08}>
        <div className="space-y-4">
          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <CardTitle>{t("Shared.homeWorkspace.recentTransactions")}</CardTitle>
                {activityNotice ? (
                  <CardDescription>{activityNotice}</CardDescription>
                ) : (
                  <CardDescription>{t("Shared.homeWorkspace.activityDescription")}</CardDescription>
                )}
              </div>
              <Button asChild variant="secondary" size="sm">
                <Link href="/dashboard/payments">{t("Shared.homeWorkspace.seeAllPayments")}</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {activityError ? (
                <p className="text-sm text-destructive-strong">{activityError}</p>
              ) : activityRows.length === 0 ? (
                <p className="text-sm text-secondary">{emptyActivityMessage}</p>
              ) : (
                <TooltipProvider>
                  <Table className="min-w-0 [&_table]:table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[8rem] pl-6">
                          {t("Shared.homeWorkspace.time")}
                        </TableHead>
                        <TableHead className="w-[calc(100%-8rem)] md:hidden">
                          {t("Shared.homeWorkspace.activity")}
                        </TableHead>
                        <TableHead className="hidden w-[10rem] md:table-cell">
                          {t("Shared.homeWorkspace.type")}
                        </TableHead>
                        <TableHead className="hidden w-[8rem] md:table-cell">
                          {t("Shared.homeWorkspace.token")}
                        </TableHead>
                        <TableHead className="hidden w-[10rem] md:table-cell">
                          {t("Shared.homeWorkspace.amount")}
                        </TableHead>
                        <TableHead className="hidden pr-6 md:table-cell">
                          {t("Shared.homeWorkspace.address")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {activityRows.map((row) => {
                        const timeLabel = formatRelativeTime(row.createdAt, locale);
                        const amountLabel =
                          row.amount === "—"
                            ? "—"
                            : formatDisplayAmount(row.amount, row.token, locale);

                        return (
                          <TableRow key={row.id}>
                            <TableCell className="pl-6 text-secondary">{timeLabel}</TableCell>
                            <TableCell className="min-w-0 md:hidden">
                              <div className="min-w-0">
                                <div className="truncate font-medium">{row.type}</div>
                                <div className="mt-1 truncate text-xs text-tertiary">
                                  {amountLabel}
                                </div>
                                <ActivityAddress
                                  row={row}
                                  cluster={cluster}
                                  className="mt-1 truncate font-mono text-xs text-tertiary"
                                />
                              </div>
                            </TableCell>
                            <TableCell className="hidden font-medium md:table-cell">
                              {row.type}
                            </TableCell>
                            <TableCell className="hidden text-secondary md:table-cell">
                              <TruncatedTableText value={row.token} className="truncate" />
                            </TableCell>
                            <TableCell className="hidden text-secondary md:table-cell">
                              <TruncatedTableText value={amountLabel} className="truncate" />
                            </TableCell>
                            <TableCell className="hidden pr-6 font-mono text-xs text-secondary md:table-cell">
                              <ActivityAddress row={row} cluster={cluster} className="truncate" />
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
        </div>
      </SectionEntry>
    </div>
  );
}
