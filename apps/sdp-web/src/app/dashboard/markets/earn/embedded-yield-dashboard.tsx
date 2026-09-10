"use client";

import type {
  EarnExternalWalletPosition,
  EarnExternalWalletPositionSummary,
  EarnExternalWalletStrategyTotal,
  EarnStrategy,
  SolanaCluster,
} from "@sdp/types";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  InfoIcon,
  Layers3Icon,
  WalletIcon,
} from "lucide-react";
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import Link from "next/link";
import { Fragment, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerAddressUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { EmbeddedYieldPortfolioSkeleton } from "../markets-route-skeletons";
import { earnStrategyLiquidityLabel } from "./earn-format";
import { earnMintAsset, formatProviderAmount } from "./earn-market-presentation";
import { useEarnExternalWalletPositionSummary, useEarnStrategies } from "./earn-program-data";

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

interface PortfolioChartValue {
  id: string;
  label: string;
  value: number;
}

type PortfolioAgeBucket = "week" | "month" | "quarter" | "older";

interface PortfolioAgePoint {
  id: PortfolioAgeBucket;
  value: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const PORTFOLIO_AGE_BUCKETS = [
  { id: "week", maxDays: 7 },
  { id: "month", maxDays: 30 },
  { id: "quarter", maxDays: 90 },
  { id: "older", maxDays: Number.POSITIVE_INFINITY },
] as const satisfies ReadonlyArray<{ id: PortfolioAgeBucket; maxDays: number }>;
const PORTFOLIO_CHART_COLORS = [
  "var(--sdp-series-1)",
  "var(--sdp-series-2)",
  "var(--sdp-series-3)",
  "var(--sdp-series-4)",
] as const;

function portfolioPositions(summary: EarnExternalWalletPositionSummary) {
  const byId = new Map<string, EarnExternalWalletPosition>();
  for (const strategy of summary.totalsByStrategy) {
    for (const position of strategy.positions ?? []) byId.set(position.id, position);
  }
  return [...byId.values()];
}

function buildAgeDistribution(
  positions: EarnExternalWalletPosition[],
  kind: "positions" | "wallets",
  now = Date.now()
): PortfolioAgePoint[] {
  const createdAtByWallet = new Map<string, number>();
  const positionCreatedAt: number[] = [];

  for (const position of positions) {
    const createdAt = Date.parse(position.createdAt);
    if (!Number.isFinite(createdAt)) continue;
    positionCreatedAt.push(createdAt);
    const walletCreatedAt = createdAtByWallet.get(position.ownerAddress);
    if (walletCreatedAt === undefined || createdAt < walletCreatedAt) {
      createdAtByWallet.set(position.ownerAddress, createdAt);
    }
  }

  const timestamps = kind === "positions" ? positionCreatedAt : [...createdAtByWallet.values()];
  const counts = new Map<PortfolioAgeBucket, number>(
    PORTFOLIO_AGE_BUCKETS.map(({ id }) => [id, 0])
  );
  for (const createdAt of timestamps) {
    const ageDays = Math.max(0, Math.floor((now - createdAt) / DAY_MS));
    const bucket = PORTFOLIO_AGE_BUCKETS.find(({ maxDays }) => ageDays <= maxDays);
    if (bucket) counts.set(bucket.id, (counts.get(bucket.id) ?? 0) + 1);
  }

  return PORTFOLIO_AGE_BUCKETS.map(({ id }) => ({ id, value: counts.get(id) ?? 0 }));
}

function AgeDistributionChart({
  kind,
  label,
  points,
}: {
  kind: "positions" | "wallets";
  label: string;
  points: PortfolioAgePoint[];
}) {
  const reduceMotion = useReducedMotion();
  const t = useTranslations();
  const width = 260;
  const height = 62;
  const baseline = 58;
  const maxValue = Math.max(...points.map(({ value }) => value), 1);
  const color = kind === "wallets" ? "var(--sdp-series-4)" : "var(--sdp-series-3)";
  const bucketLabels: Record<PortfolioAgeBucket, string> = {
    week: t("DashboardMarkets.earnProgram.ageUnderWeek"),
    month: t("DashboardMarkets.earnProgram.ageUnderMonth"),
    quarter: t("DashboardMarkets.earnProgram.ageUnderQuarter"),
    older: t("DashboardMarkets.earnProgram.ageOlder"),
  };
  const accessibleLabel = `${label}: ${points
    .map(({ id, value }) => `${bucketLabels[id]} ${value}`)
    .join(", ")}`;

  return (
    <div>
      <p className="mb-1 text-[11px] leading-4 text-tertiary">{label}</p>
      <m.svg
        aria-label={accessibleLabel}
        className="h-[3.875rem] w-full overflow-visible"
        data-portfolio-chart={kind}
        initial={reduceMotion ? false : { opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.35, ease: "easeOut" }}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <path d={`M0 ${baseline} H${width}`} stroke="currentColor" strokeOpacity="0.1" />
        {points.map(({ id, value }, index) => {
          const slotWidth = width / points.length;
          const barHeight = (value / maxValue) * 44;
          return (
            <m.rect
              animate={{ opacity: 0.78, scaleY: 1 }}
              fill={color}
              height={barHeight}
              initial={reduceMotion ? false : { opacity: 0, scaleY: 0 }}
              key={id}
              rx="4"
              style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}
              transition={reduceMotion ? { duration: 0 } : { delay: index * 0.06, duration: 0.35 }}
              width={slotWidth * 0.58}
              x={index * slotWidth + slotWidth * 0.21}
              y={baseline - barHeight}
            />
          );
        })}
      </m.svg>
      <div className="grid grid-cols-4 gap-1 text-center text-[9px] leading-3 text-tertiary">
        {points.map(({ id }) => (
          <span key={id}>{bucketLabels[id]}</span>
        ))}
      </div>
    </div>
  );
}

function AssetMixChart({ values }: { values: PortfolioChartValue[] }) {
  const reduceMotion = useReducedMotion();
  const t = useTranslations();
  const positiveValues = values.filter(({ value }) => value > 0);
  const displayedValues =
    positiveValues.length <= PORTFOLIO_CHART_COLORS.length
      ? positiveValues
      : (() => {
          const sorted = [...positiveValues].sort((left, right) => right.value - left.value);
          const visible = sorted.slice(0, PORTFOLIO_CHART_COLORS.length - 1);
          return [
            ...visible,
            {
              id: "portfolio-other-assets",
              label: t("DashboardMarkets.earnProgram.otherAssets"),
              value: sorted
                .slice(PORTFOLIO_CHART_COLORS.length - 1)
                .reduce((sum, { value }) => sum + value, 0),
            },
          ];
        })();
  const chartValues =
    displayedValues.length > 0 ? displayedValues : [{ id: "empty", label: "", value: 1 }];
  const total = chartValues.reduce((sum, { value }) => sum + value, 0);
  const radius = 23;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div
      className="flex min-h-[5.25rem] items-center justify-between gap-5"
      data-portfolio-chart="assets"
    >
      <m.svg
        aria-hidden="true"
        className="size-[5.25rem] shrink-0 -rotate-90"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.82 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.35, ease: "easeOut" }}
        viewBox="0 0 56 56"
      >
        <circle
          cx="28"
          cy="28"
          fill="none"
          r={radius}
          stroke="currentColor"
          strokeOpacity="0.08"
          strokeWidth="8"
        />
        {chartValues.map(({ id, value }, index) => {
          const length = (value / total) * circumference;
          const segmentOffset = offset;
          offset += length;
          return (
            <m.circle
              animate={{ opacity: 1 }}
              cx="28"
              cy="28"
              fill="none"
              initial={reduceMotion ? false : { opacity: 0 }}
              key={id}
              r={radius}
              stroke={PORTFOLIO_CHART_COLORS[index % PORTFOLIO_CHART_COLORS.length]}
              strokeDasharray={`${Math.max(length - 2.5, 0)} ${circumference}`}
              strokeDashoffset={-segmentOffset}
              strokeLinecap="round"
              strokeWidth="8"
              transition={reduceMotion ? { duration: 0 } : { delay: index * 0.08, duration: 0.35 }}
            />
          );
        })}
      </m.svg>
      <div className="min-w-0 flex-1 space-y-2">
        {displayedValues.map(({ id, label, value }, index) => (
          <div className="flex items-center justify-between gap-3 text-xs" key={id}>
            <span className="flex min-w-0 items-center gap-2 text-secondary">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: PORTFOLIO_CHART_COLORS[index % PORTFOLIO_CHART_COLORS.length],
                }}
              />
              <span className="truncate">{label}</span>
            </span>
            <span className="text-primary tabular-nums">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type PortfolioMetricKind = "assets" | "positions" | "wallets";

function PortfolioMetric({
  ageLabel,
  agePoints,
  chartValues,
  kind,
  label,
  value,
}: {
  ageLabel?: string;
  agePoints?: PortfolioAgePoint[];
  chartValues?: PortfolioChartValue[];
  kind: PortfolioMetricKind;
  label: string;
  value: number;
}) {
  return (
    <Card
      className="group min-h-44 min-w-0 gap-0 overflow-hidden rounded-2xl px-5 py-5 transition-[box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none"
      data-portfolio-metric={kind}
    >
      <div className="flex items-start justify-between gap-4">
        <dt className="text-sm leading-5 font-normal text-tertiary">{label}</dt>
        <dd className="text-xl leading-6 font-medium tracking-[-0.2px] text-primary tabular-nums">
          {value}
        </dd>
      </div>
      <div className="mt-auto pt-4">
        {kind === "wallets" && ageLabel && agePoints ? (
          <AgeDistributionChart kind="wallets" label={ageLabel} points={agePoints} />
        ) : null}
        {kind === "positions" && ageLabel && agePoints ? (
          <AgeDistributionChart kind="positions" label={ageLabel} points={agePoints} />
        ) : null}
        {kind === "assets" ? <AssetMixChart values={chartValues ?? []} /> : null}
      </div>
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

function formatLatestDepositDate(
  positions: readonly EarnExternalWalletPosition[] | undefined,
  locale: string
): string {
  const latest = (positions ?? []).reduce<number | undefined>((current, position) => {
    const createdAt = Date.parse(position.createdAt);
    if (!Number.isFinite(createdAt)) return current;
    return current === undefined || createdAt > current ? createdAt : current;
  }, undefined);
  if (latest === undefined) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(latest);
}

function strategyReferenceKey(provider: string, providerReference: string): string {
  return JSON.stringify([provider, providerReference]);
}

function StrategyAvailability({ strategy }: { strategy?: EarnStrategy }) {
  const t = useTranslations();
  if (!strategy) return <span className="text-sm text-tertiary">—</span>;

  const liquidity = earnStrategyLiquidityLabel(strategy, t) ?? "—";
  return <span className="text-sm text-secondary">{liquidity}</span>;
}

function StrategyWalletDetails({
  strategy,
  strategyDefinition,
  cluster,
}: {
  strategy: EarnExternalWalletStrategyTotal;
  strategyDefinition?: EarnStrategy;
  cluster: SolanaCluster;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const positions = [...(strategy.positions ?? [])].sort((left, right) =>
    left.ownerAddress.localeCompare(right.ownerAddress)
  );

  return (
    <section aria-label={strategy.label} className="bg-fill-subtle">
      {!strategy.positions ? (
        <div className="border-y border-warning-border bg-warning-bg px-6 py-4 text-sm text-warning">
          {t("DashboardMarkets.earnProgram.walletRefreshError")}
        </div>
      ) : (
        <div className="divide-y divide-border-subtle">
          {positions.map((position) => {
            const asset = earnMintAsset(position.tokenMint);
            return (
              <article
                key={position.id}
                className="grid grid-cols-[minmax(12rem,1.35fr)_minmax(6rem,0.6fr)_minmax(8rem,0.75fr)_minmax(8rem,0.8fr)_minmax(8rem,0.8fr)_auto] items-center gap-5 bg-surface-raised px-6 py-3.5 transition-colors hover:bg-fill-subtle"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary">
                    <WalletIcon aria-hidden="true" className="size-3.5" />
                  </span>
                  <p className="truncate text-sm text-primary" title={position.ownerAddress}>
                    {compactAddress(position.ownerAddress)}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-sm text-secondary">
                  <TokenMark mint={asset.mint} size="sm" symbol={asset.symbol} />
                  {asset.symbol}
                </div>
                <div>
                  <p className="mb-1 text-xs text-tertiary">
                    {t("DashboardMarkets.earnProgram.availability")}
                  </p>
                  <StrategyAvailability strategy={strategyDefinition} />
                </div>
                <div>
                  <p className="text-xs text-tertiary">
                    {t("DashboardMarkets.earnProgram.liveValue")}
                  </p>
                  <p className="mt-0.5 text-sm text-primary tabular-nums">
                    {position.tokenValue === undefined
                      ? t("DashboardMarkets.earnProgram.valueUnavailable")
                      : formatProviderAmount(position.tokenValue, locale, asset.symbol)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-tertiary">
                    {t("DashboardMarkets.earnProgram.availableShares")}
                  </p>
                  <p className="mt-0.5 text-sm text-primary tabular-nums">
                    {position.withdrawableShares ??
                      position.shares ??
                      t("DashboardMarkets.earnProgram.valueUnavailable")}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={t("DashboardMarkets.earnProgram.copyWalletAddress")}
                    className="inline-flex size-8 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-fill-strong hover:text-primary"
                    onClick={() => void navigator.clipboard.writeText(position.ownerAddress)}
                  >
                    <CopyIcon aria-hidden="true" className="size-3.5" />
                  </button>
                  <a
                    aria-label={t("DashboardMarkets.earnProgram.openWalletInExplorer")}
                    className="inline-flex size-8 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-fill-strong hover:text-primary"
                    href={explorerAddressUrl(position.ownerAddress, cluster)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PortfolioByStrategy({
  summary,
  strategies,
  cluster,
  selectedStrategyId,
  onStrategyToggle,
}: {
  summary: EarnExternalWalletPositionSummary;
  strategies?: EarnStrategy[];
  cluster: SolanaCluster;
  selectedStrategyId: string | null;
  onStrategyToggle: (strategy: EarnExternalWalletStrategyTotal) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const strategiesByReference = new Map(
    (strategies ?? []).map((strategy) => [
      strategyReferenceKey(strategy.provider, strategy.providerReference),
      strategy,
    ])
  );

  return (
    <Card className="overflow-hidden rounded-2xl">
      <CardHeader>
        <CardTitle>{t("DashboardMarkets.earnProgram.portfolioTitle")}</CardTitle>
        <CardDescription>{t("DashboardMarkets.earnProgram.portfolioDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto border-y border-border-subtle">
          <Table style={{ minWidth: "72rem" }}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("DashboardMarkets.earnProgram.strategy")}</TableHead>
                <TableHead>{t("DashboardMarkets.earnProgram.asset")}</TableHead>
                <TableHead>{t("DashboardMarkets.earnProgram.customerWallets")}</TableHead>
                <TableHead>{t("DashboardMarkets.earnProgram.livePositions")}</TableHead>
                <TableHead>{t("DashboardMarkets.earnProgram.lastDeposit")}</TableHead>
                <TableHead>{t("DashboardMarkets.earnProgram.availability")}</TableHead>
                <TableHead align="right">{t("DashboardMarkets.earnProgram.liveValue")}</TableHead>
                <TableHead align="right">
                  <span className="sr-only">
                    {t("DashboardMarkets.earnProgram.customerWallets")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.totalsByStrategy.map((strategy) => {
                const strategyId = `${strategy.provider}:${strategy.providerReference}`;
                const safeStrategyId = strategyId.replace(/[^a-zA-Z0-9_-]/g, "-");
                const detailsId = safeStrategyId;
                const isOpen = selectedStrategyId === strategyId;
                const strategyDefinition = strategiesByReference.get(
                  strategyReferenceKey(strategy.provider, strategy.providerReference)
                );
                return (
                  <Fragment key={strategyId}>
                    <TableRow
                      aria-label={t("DashboardMarkets.earnProgram.viewCustomerWallets", {
                        strategy: strategy.label,
                      })}
                      aria-controls={detailsId}
                      aria-expanded={isOpen}
                      className="cursor-pointer transition-colors hover:bg-fill-subtle focus-visible:bg-fill-subtle focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                      tabIndex={0}
                      onClick={() => onStrategyToggle(strategy)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onStrategyToggle(strategy);
                        }
                      }}
                    >
                      <TableCell>
                        <div>
                          <p className="text-sm text-primary">{strategy.label}</p>
                          <p className="mt-0.5 text-xs capitalize text-tertiary">
                            {strategy.provider}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          {strategy.totalsByToken.map((total) => {
                            const asset = earnMintAsset(total.tokenMint);
                            return (
                              <span
                                className="flex items-center gap-2 text-sm text-primary"
                                key={total.tokenMint}
                              >
                                <TokenMark mint={asset.mint} size="sm" symbol={asset.symbol} />
                                {asset.symbol}
                              </span>
                            );
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">{strategy.walletCount}</TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {strategy.positionCount}
                      </TableCell>
                      <TableCell className="text-sm text-secondary">
                        {formatLatestDepositDate(strategy.positions, locale)}
                      </TableCell>
                      <TableCell>
                        <StrategyAvailability strategy={strategyDefinition} />
                      </TableCell>
                      <TableCell align="right">
                        <div className="flex flex-col items-end gap-1">
                          {strategy.totalsByToken.map((total) => {
                            const asset = earnMintAsset(total.tokenMint);
                            return total.tokenValue === undefined ? (
                              <Badge key={total.tokenMint} variant="warning">
                                {t("DashboardMarkets.earnProgram.valueUnavailable")}
                              </Badge>
                            ) : (
                              <span
                                className="text-sm text-primary tabular-nums"
                                key={total.tokenMint}
                              >
                                {formatProviderAmount(total.tokenValue, locale, asset.symbol)}
                              </span>
                            );
                          })}
                        </div>
                      </TableCell>
                      <TableCell align="right" className="w-12">
                        <m.span
                          animate={{ rotate: isOpen ? 90 : 0 }}
                          className="inline-flex size-8 items-center justify-center rounded-lg text-tertiary"
                          transition={{ duration: 0.22, ease: "easeOut" }}
                        >
                          <ChevronRightIcon aria-hidden="true" className="size-4" />
                        </m.span>
                      </TableCell>
                    </TableRow>
                    <AnimatePresence initial={false}>
                      {isOpen ? (
                        <m.tr
                          animate={{ opacity: 1 }}
                          className="border-b border-border-subtle"
                          exit={{ opacity: 0 }}
                          id={detailsId}
                          initial={{ opacity: 0 }}
                          key={`${strategyId}:details`}
                          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                        >
                          <td className="p-0 align-top" colSpan={8}>
                            <m.div
                              animate={{ opacity: 1, scaleY: 1, y: 0 }}
                              className="origin-top overflow-hidden"
                              exit={{ opacity: 0, scaleY: 0.98, y: -6 }}
                              initial={{ opacity: 0, scaleY: 0.98, y: -6 }}
                              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                            >
                              <StrategyWalletDetails
                                cluster={cluster}
                                strategy={strategy}
                                strategyDefinition={strategyDefinition}
                              />
                            </m.div>
                          </td>
                        </m.tr>
                      ) : null}
                    </AnimatePresence>
                  </Fragment>
                );
              })}
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
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const { strategies } = useEarnStrategies();
  const { summary, error, isInitialLoading } = useEarnExternalWalletPositionSummary({
    detailsVisible: selectedStrategyId !== null,
  });
  const positions = summary ? portfolioPositions(summary) : [];
  const walletAges = buildAgeDistribution(positions, "wallets");
  const positionAges = buildAgeDistribution(positions, "positions");

  if (isInitialLoading) return <EmbeddedYieldPortfolioSkeleton />;

  return (
    <LazyMotion features={domAnimation}>
      <DashboardWorkspaceOverviewPanel>
        <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-4 pt-3">
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
                  ageLabel={t("DashboardMarkets.earnProgram.customerWalletAgeDistribution")}
                  agePoints={walletAges}
                  kind="wallets"
                  label={t("DashboardMarkets.earnProgram.customerWallets")}
                  value={summary.walletCount}
                />
                <PortfolioMetric
                  ageLabel={t("DashboardMarkets.earnProgram.livePositionAgeDistribution")}
                  agePoints={positionAges}
                  kind="positions"
                  label={t("DashboardMarkets.earnProgram.livePositions")}
                  value={summary.positionCount}
                />
                <PortfolioMetric
                  chartValues={summary.totalsByToken.map((total) => ({
                    id: total.tokenMint,
                    label: earnMintAsset(total.tokenMint).symbol,
                    value: total.positionCount,
                  }))}
                  kind="assets"
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
                <PortfolioByStrategy
                  cluster={cluster}
                  selectedStrategyId={selectedStrategyId}
                  strategies={strategies}
                  summary={summary}
                  onStrategyToggle={(strategy) => {
                    const strategyId = `${strategy.provider}:${strategy.providerReference}`;
                    setSelectedStrategyId((current) =>
                      current === strategyId ? null : strategyId
                    );
                  }}
                />
              )}
            </>
          )}
        </div>
      </DashboardWorkspaceOverviewPanel>
    </LazyMotion>
  );
}
