"use client";

import type {
  EarnExternalWalletPosition,
  EarnExternalWalletPositionSummary,
  EarnExternalWalletStrategyTotal,
  SolanaCluster,
} from "@sdp/types";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  InfoIcon,
  Layers3Icon,
  LoaderCircleIcon,
  WalletIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { type CSSProperties, useEffect, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { ListEmptyState } from "@/components/ui/list-empty-state";
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
import { explorerAddressUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { EmbeddedYieldPortfolioSkeleton } from "../markets-route-skeletons";
import { earnMintAsset, formatProviderAmount } from "./earn-market-presentation";
import {
  fetchEarnExternalWalletPositions,
  useEarnExternalWalletPositionSummary,
} from "./earn-program-data";

const STRATEGY_WALLET_REFRESH_INTERVAL_MS = process.env.NODE_ENV === "development" ? 3_000 : 15_000;

function PortfolioInfoTip({ label }: { label: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={label}
            className="inline-flex items-center justify-center rounded-full text-tertiary transition-colors hover:text-primary"
            type="button"
          >
            <InfoIcon aria-hidden="true" className="size-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72 text-xs leading-5">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PortfolioMetric({ label, value }: { label: string; value: number }) {
  return (
    <Card className="min-w-0 gap-0 rounded-2xl px-7 py-7">
      <dt className="flex items-center gap-1.5 text-sm leading-5 font-normal text-tertiary">
        {label}
      </dt>
      <dd className="mt-3 text-[28px] leading-8 font-medium tracking-[-0.2px] text-primary tabular-nums">
        {value}
      </dd>
    </Card>
  );
}

function PortfolioOnboarding({ configureHref }: { configureHref: string }) {
  const t = useTranslations();

  return (
    <Card className="gap-0 rounded-2xl px-7 py-10 shadow-[0_18px_24px_rgba(0,0,0,0.05)]">
      <div className="flex flex-col items-center text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-fill-subtle text-secondary">
          <Layers3Icon aria-hidden="true" className="size-6" />
        </span>
        <h2 className="mt-4 text-[19px] leading-6 font-medium text-primary">
          {t("DashboardMarkets.earnProgram.introTitle")}
        </h2>
        <p className="mt-2 max-w-[32rem] text-sm leading-5 text-secondary">
          {t("DashboardMarkets.earnProgram.introDescription")}
        </p>

        <Button asChild className="mt-8" variant="secondary">
          <Link href={configureHref}>{t("DashboardMarkets.earnProgram.configureShort")}</Link>
        </Button>
      </div>
    </Card>
  );
}

function compactAddress(value: string) {
  return `${value.slice(0, 5)}…${value.slice(-5)}`;
}

function StrategyWalletDrawer({
  strategy,
  cluster,
  open,
  onOpenChange,
}: {
  strategy: EarnExternalWalletStrategyTotal | null;
  cluster: SolanaCluster;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const [positions, setPositions] = useState<EarnExternalWalletPosition[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open || !strategy) return;
    const currentStrategy = strategy;
    let active = true;
    let refreshing = false;
    setPositions(null);
    setError(false);

    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      try {
        const pages = await Promise.all(
          currentStrategy.ownerAddresses.map(fetchEarnExternalWalletPositions)
        );
        if (!active) return;
        setPositions(
          pages
            .flat()
            .filter(
              (position) =>
                position.provider === currentStrategy.provider &&
                position.providerReference === currentStrategy.providerReference
            )
            .sort((left, right) => left.ownerAddress.localeCompare(right.ownerAddress))
        );
        setError(false);
      } catch {
        if (active) setError(true);
      } finally {
        refreshing = false;
      }
    }

    void refresh();
    const interval = window.setInterval(() => void refresh(), STRATEGY_WALLET_REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [open, strategy]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent
        style={
          {
            "--drawer-content-width": "min(34rem, calc(100vw - 1rem))",
          } as CSSProperties
        }
      >
        <div className="flex items-start justify-between border-b border-border-default px-6 py-5">
          <div>
            <DrawerTitle className="text-lg font-medium text-primary">
              {strategy?.label ?? t("DashboardMarkets.earnProgram.customerWallets")}
            </DrawerTitle>
            <p className="mt-1 text-sm text-secondary">
              {strategy
                ? t(
                    strategy.walletCount === 1
                      ? "DashboardMarkets.earnProgram.customerWalletCount"
                      : "DashboardMarkets.earnProgram.customerWalletCountPlural",
                    { count: strategy.walletCount }
                  )
                : ""}
            </p>
          </div>
          <DrawerClose
            type="button"
            aria-label={t("Shared.SharedComponents.close")}
            className="inline-flex size-8 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-fill-subtle hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </DrawerClose>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {!positions && !error ? (
            <div className="flex min-h-48 items-center justify-center text-secondary">
              <LoaderCircleIcon aria-hidden="true" className="size-5 animate-spin" />
              <span className="ml-2 text-sm">
                {t("DashboardMarkets.earnProgram.walletValuesLoading")}
              </span>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
              {t("DashboardMarkets.earnProgram.walletRefreshError")}
            </div>
          ) : null}

          {positions ? (
            <div className="space-y-3">
              {positions.map((position, index) => {
                const asset = earnMintAsset(position.tokenMint);
                return (
                  <article
                    key={position.id}
                    className="rounded-2xl border border-border-default bg-surface-raised p-5 shadow-[0_12px_28px_rgba(0,0,0,0.04)]"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fill-subtle text-secondary">
                          <WalletIcon aria-hidden="true" className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-primary">
                            {t("DashboardMarkets.earnProgram.customerWallet", {
                              index: index + 1,
                            })}
                          </p>
                          <p className="mt-0.5 font-mono text-xs text-tertiary">
                            {compactAddress(position.ownerAddress)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={t("DashboardMarkets.earnProgram.copyWalletAddress")}
                          className="inline-flex size-8 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-fill-subtle hover:text-primary"
                          onClick={() => void navigator.clipboard.writeText(position.ownerAddress)}
                        >
                          <CopyIcon aria-hidden="true" className="size-3.5" />
                        </button>
                        <a
                          aria-label={t("DashboardMarkets.earnProgram.openWalletInExplorer")}
                          className="inline-flex size-8 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-fill-subtle hover:text-primary"
                          href={explorerAddressUrl(position.ownerAddress, cluster)}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                        </a>
                      </div>
                    </div>

                    <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-border-subtle pt-4">
                      <div>
                        <dt className="text-xs text-tertiary">
                          {t("DashboardMarkets.earnProgram.liveValue")}
                        </dt>
                        <dd className="mt-1 text-sm font-medium text-primary tabular-nums">
                          {position.tokenValue === undefined
                            ? t("DashboardMarkets.earnProgram.valueUnavailable")
                            : formatProviderAmount(position.tokenValue, locale, asset.symbol)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-tertiary">
                          {t("DashboardMarkets.earnProgram.asset")}
                        </dt>
                        <dd className="mt-1 flex items-center gap-2 text-sm font-medium text-primary">
                          <TokenMark mint={asset.mint} size="sm" symbol={asset.symbol} />
                          {asset.symbol}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-tertiary">
                          {t("DashboardMarkets.earnProgram.vaultShares")}
                        </dt>
                        <dd className="mt-1 text-sm text-primary tabular-nums">
                          {position.shares ?? t("DashboardMarkets.earnProgram.valueUnavailable")}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-tertiary">
                          {t("DashboardMarkets.earnProgram.availableShares")}
                        </dt>
                        <dd className="mt-1 text-sm text-primary tabular-nums">
                          {position.withdrawableShares ??
                            t("DashboardMarkets.earnProgram.valueUnavailable")}
                        </dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          ) : null}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function PortfolioByStrategy({
  summary,
  onStrategySelect,
}: {
  summary: EarnExternalWalletPositionSummary;
  onStrategySelect: (strategy: EarnExternalWalletStrategyTotal) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();

  return (
    <Card className="overflow-hidden rounded-2xl">
      <CardHeader>
        <CardTitle>{t("DashboardMarkets.earnProgram.portfolioTitle")}</CardTitle>
        <CardDescription>{t("DashboardMarkets.earnProgram.portfolioDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto border-y border-border-subtle">
          <Table style={{ minWidth: "48rem" }}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("DashboardMarkets.earnProgram.strategy")}</TableHead>
                <TableHead>{t("DashboardMarkets.earnProgram.asset")}</TableHead>
                <TableHead>{t("DashboardMarkets.earnProgram.customerWallets")}</TableHead>
                <TableHead>{t("DashboardMarkets.earnProgram.livePositions")}</TableHead>
                <TableHead align="right">{t("DashboardMarkets.earnProgram.liveValue")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.totalsByStrategy.flatMap((strategy) =>
                strategy.totalsByToken.map((total) => {
                  const asset = earnMintAsset(total.tokenMint);
                  return (
                    <TableRow
                      key={`${strategy.provider}:${strategy.providerReference}:${total.tokenMint}`}
                      aria-label={t("DashboardMarkets.earnProgram.viewCustomerWallets", {
                        strategy: strategy.label,
                      })}
                      className="cursor-pointer transition-colors hover:bg-fill-subtle focus-visible:bg-fill-subtle focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                      tabIndex={0}
                      onClick={() => onStrategySelect(strategy)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onStrategySelect(strategy);
                        }
                      }}
                    >
                      <TableCell>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm text-primary">{strategy.label}</p>
                            <p className="mt-0.5 text-xs capitalize text-tertiary">
                              {strategy.provider}
                            </p>
                          </div>
                          <ChevronRightIcon aria-hidden="true" className="size-4 text-tertiary" />
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <TokenMark mint={asset.mint} size="sm" symbol={asset.symbol} />
                          <span className="text-sm text-primary">{asset.symbol}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">{total.walletCount}</TableCell>
                      <TableCell className="text-sm tabular-nums">{total.positionCount}</TableCell>
                      <TableCell align="right">
                        {total.tokenValue === undefined ? (
                          <Badge variant="warning">
                            {t("DashboardMarkets.earnProgram.valueUnavailable")}
                          </Badge>
                        ) : (
                          <span className="text-sm text-primary tabular-nums">
                            {formatProviderAmount(total.tokenValue, locale, asset.symbol)}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function EmbeddedYieldDashboard({ configureHref }: { configureHref: string }) {
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const { summary, error, isInitialLoading } = useEarnExternalWalletPositionSummary();
  const [selectedStrategy, setSelectedStrategy] = useState<EarnExternalWalletStrategyTotal | null>(
    null
  );

  if (isInitialLoading) return <EmbeddedYieldPortfolioSkeleton />;

  return (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <div className="mx-auto flex w-full max-w-[63rem] flex-col gap-4 pt-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="flex items-center gap-2 text-[19px] leading-6 font-medium text-primary">
            {t("DashboardMarkets.earnProgram.dashboardTitle")}
            <PortfolioInfoTip label={t("DashboardMarkets.earnProgram.dashboardDescription")} />
          </h2>
          <Button asChild size="xs">
            <Link aria-label={t("DashboardMarkets.earnProgram.configure")} href={configureHref}>
              {t("DashboardMarkets.earnProgram.configureShort")}
            </Link>
          </Button>
        </div>

        {!summary ? (
          <Card className="rounded-2xl">
            <ListEmptyState
              action={
                <Button asChild variant="secondary">
                  <Link href={configureHref}>
                    {t("DashboardMarkets.earnProgram.configureShort")}
                  </Link>
                </Button>
              }
              description={t("DashboardMarkets.earnProgram.portfolioErrorDescription")}
              icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
              message={t("DashboardMarkets.earnProgram.portfolioErrorTitle")}
            />
          </Card>
        ) : (
          <>
            <dl className="grid gap-2 sm:grid-cols-3">
              <PortfolioMetric
                label={t("DashboardMarkets.earnProgram.customerWallets")}
                value={summary.walletCount}
              />
              <PortfolioMetric
                label={t("DashboardMarkets.earnProgram.livePositions")}
                value={summary.positionCount}
              />
              <PortfolioMetric
                label={t("DashboardMarkets.earnProgram.assetsEarning")}
                value={summary.totalsByToken.length}
              />
            </dl>

            <div
              aria-atomic="true"
              className={
                error
                  ? "flex items-start gap-3 rounded-xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning"
                  : "sr-only"
              }
              role="status"
            >
              {error ? (
                <>
                  <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <p>{t("DashboardMarkets.earnProgram.portfolioRefreshError")}</p>
                </>
              ) : null}
            </div>

            {summary.unavailablePositionCount > 0 ? (
              <div className="flex items-start gap-3 rounded-xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
                <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <p>
                  {t("DashboardMarkets.earnProgram.incompletePortfolio", {
                    count: summary.unavailablePositionCount,
                  })}
                </p>
              </div>
            ) : null}

            {/* The removed UI builder persists no configuration, so zero recorded positions is
                the only truthful empty portfolio state. */}
            {summary.positionCount === 0 ? (
              <PortfolioOnboarding configureHref={configureHref} />
            ) : (
              <PortfolioByStrategy summary={summary} onStrategySelect={setSelectedStrategy} />
            )}
          </>
        )}
      </div>
      <StrategyWalletDrawer
        cluster={cluster}
        open={selectedStrategy !== null}
        strategy={selectedStrategy}
        onOpenChange={(open) => {
          if (!open) setSelectedStrategy(null);
        }}
      />
    </DashboardWorkspaceOverviewPanel>
  );
}
