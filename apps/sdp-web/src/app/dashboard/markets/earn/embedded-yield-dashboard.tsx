"use client";

import type { EarnExternalWalletPositionSummary } from "@sdp/types";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CircleDollarSignIcon,
  Code2Icon,
  ImageIcon,
  InfoIcon,
  Layers3Icon,
} from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
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
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { EmbeddedYieldPortfolioSkeleton } from "../markets-route-skeletons";
import { earnMintAsset, formatProviderAmount } from "./earn-market-presentation";
import { useEarnExternalWalletPositionSummary } from "./earn-program-data";

const ONBOARDING_STEPS = [
  { icon: CircleDollarSignIcon, key: "DashboardMarkets.earnProgram.flowSelect" },
  { icon: ImageIcon, key: "DashboardMarkets.earnProgram.flowPreview" },
  { icon: Code2Icon, key: "DashboardMarkets.earnProgram.flowIntegrate" },
] as const satisfies ReadonlyArray<{ icon: typeof Layers3Icon; key: MessageKey }>;

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
    <Card className="gap-0 rounded-2xl px-7 py-7 shadow-[0_18px_24px_rgba(0,0,0,0.05)]">
      <div className="flex flex-col items-center py-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-fill-subtle text-secondary">
          <Layers3Icon aria-hidden="true" className="size-6" />
        </span>
        <h2 className="mt-4 text-[19px] leading-6 font-medium text-primary">
          {t("DashboardMarkets.earnProgram.introTitle")}
        </h2>
        <p className="mt-2 max-w-[32rem] text-sm leading-5 text-secondary">
          {t("DashboardMarkets.earnProgram.introDescription")}
        </p>

        <ol className="mt-8 grid w-full items-center gap-3 text-left md:grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1fr)_1.5rem_minmax(0,1fr)] md:gap-0">
          {ONBOARDING_STEPS.map(({ icon: Icon, key }, index) => (
            <Fragment key={key}>
              <li className="flex h-20 min-w-0 items-center gap-4 rounded-xl border-2 border-border-default px-4">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-fill-subtle text-secondary">
                  <Icon aria-hidden="true" className="size-6" />
                </span>
                <span className="min-w-0 text-base leading-6 font-medium text-secondary">
                  {t(key)}
                </span>
              </li>
              {index < ONBOARDING_STEPS.length - 1 ? (
                <ArrowRightIcon
                  aria-hidden="true"
                  className="mx-auto hidden size-4 text-tertiary md:block"
                />
              ) : null}
            </Fragment>
          ))}
        </ol>

        <Button asChild className="mt-10" variant="secondary">
          <Link href={configureHref}>{t("DashboardMarkets.earnProgram.getStarted")}</Link>
        </Button>
      </div>
    </Card>
  );
}

function PortfolioByStrategy({ summary }: { summary: EarnExternalWalletPositionSummary }) {
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
                    >
                      <TableCell>
                        <p className="text-sm text-primary">{strategy.label}</p>
                        <p className="mt-0.5 text-xs capitalize text-tertiary">
                          {strategy.provider}
                        </p>
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
  const { summary, error, isInitialLoading } = useEarnExternalWalletPositionSummary();

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
              <PortfolioByStrategy summary={summary} />
            )}
          </>
        )}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
