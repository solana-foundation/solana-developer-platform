"use client";

import {
  AlertTriangleIcon,
  ArrowRightIcon,
  Layers3Icon,
  Settings2Icon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
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
import { useLocale, useTranslations } from "@/i18n/provider";
import { EarnProgramSkeleton } from "../markets-route-skeletons";
import { earnMintAsset, formatProviderAmount } from "./earn-market-presentation";
import { useEarnExternalWalletPositionSummary } from "./earn-program-data";

function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof UsersIcon;
}) {
  return (
    <div className="flex min-h-28 items-start justify-between gap-4 px-5 py-5">
      <div>
        <p className="text-sm text-secondary">{label}</p>
        <p className="mt-3 text-3xl font-medium tracking-tight text-primary tabular-nums">
          {value}
        </p>
      </div>
      <span className="flex size-9 items-center justify-center rounded-lg bg-fill-subtle text-secondary">
        <Icon aria-hidden="true" className="size-4" />
      </span>
    </div>
  );
}

export function EmbeddedYieldDashboard({ configureHref }: { configureHref: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const { summary, error, isLoading } = useEarnExternalWalletPositionSummary();

  if (isLoading) return <EarnProgramSkeleton />;

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">
              {t("DashboardMarkets.earnProgram.dashboardEyebrow")}
            </p>
            <p className="mt-2 text-sm leading-6 text-secondary">
              {t("DashboardMarkets.earnProgram.dashboardDescription")}
            </p>
          </div>
          <Button asChild iconLeft={<Settings2Icon />}>
            <Link href={configureHref}>{t("DashboardMarkets.earnProgram.configure")}</Link>
          </Button>
        </div>

        {error || !summary ? (
          <Card>
            <ListEmptyState
              action={
                <Button asChild variant="secondary">
                  <Link href={configureHref}>{t("DashboardMarkets.earnProgram.configure")}</Link>
                </Button>
              }
              description={t("DashboardMarkets.earnProgram.portfolioErrorDescription")}
              icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
              message={t("DashboardMarkets.earnProgram.portfolioErrorTitle")}
            />
          </Card>
        ) : (
          <>
            <Card className="gap-0 overflow-hidden py-0">
              <div className="grid divide-y divide-border-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <Metric
                  label={t("DashboardMarkets.earnProgram.customerWallets")}
                  value={summary.walletCount}
                  icon={UsersIcon}
                />
                <Metric
                  label={t("DashboardMarkets.earnProgram.livePositions")}
                  value={summary.positionCount}
                  icon={Layers3Icon}
                />
                <Metric
                  label={t("DashboardMarkets.earnProgram.assetsEarning")}
                  value={summary.totalsByToken.length}
                  icon={ArrowRightIcon}
                />
              </div>
            </Card>

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

            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>{t("DashboardMarkets.earnProgram.portfolioTitle")}</CardTitle>
                <CardDescription>
                  {t("DashboardMarkets.earnProgram.portfolioDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {summary.positionCount === 0 ? (
                  <ListEmptyState
                    action={
                      <Button asChild variant="secondary">
                        <Link href={configureHref}>
                          {t("DashboardMarkets.earnProgram.configureExperience")}
                        </Link>
                      </Button>
                    }
                    description={t("DashboardMarkets.earnProgram.portfolioEmptyDescription")}
                    icon={<Layers3Icon aria-hidden="true" className="size-5" />}
                    message={t("DashboardMarkets.earnProgram.portfolioEmptyTitle")}
                  />
                ) : (
                  <div className="overflow-x-auto border-y border-border-subtle">
                    <Table style={{ minWidth: "48rem" }}>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("DashboardMarkets.earnProgram.strategy")}</TableHead>
                          <TableHead>{t("DashboardMarkets.earnProgram.asset")}</TableHead>
                          <TableHead>{t("DashboardMarkets.earnProgram.customerWallets")}</TableHead>
                          <TableHead>{t("DashboardMarkets.earnProgram.livePositions")}</TableHead>
                          <TableHead align="right">
                            {t("DashboardMarkets.earnProgram.liveValue")}
                          </TableHead>
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
                                  <p className="text-sm font-medium text-primary">
                                    {strategy.label}
                                  </p>
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
                                <TableCell className="text-sm tabular-nums">
                                  {total.walletCount}
                                </TableCell>
                                <TableCell className="text-sm tabular-nums">
                                  {total.positionCount}
                                </TableCell>
                                <TableCell align="right">
                                  {total.tokenValue === undefined ? (
                                    <Badge variant="warning">
                                      {t("DashboardMarkets.earnProgram.valueUnavailable")}
                                    </Badge>
                                  ) : (
                                    <span className="text-sm font-medium text-primary tabular-nums">
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
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
