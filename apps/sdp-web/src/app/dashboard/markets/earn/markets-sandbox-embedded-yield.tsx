"use client";

import { Layers3Icon, WalletIcon } from "lucide-react";
import Link from "next/link";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useMarketsSandbox } from "../markets-sandbox-store";
import { earnProviderLabel } from "./earn-format";
import { formatProviderAmount, formatProviderApy } from "./earn-market-presentation";
import { useEarnStrategies } from "./earn-program-data";

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Card className="min-w-0 gap-0 rounded-2xl px-7 py-7">
      <dt className="text-sm leading-5 font-normal text-tertiary">{label}</dt>
      <dd className="mt-3 text-[28px] leading-8 font-medium tracking-[-0.2px] text-primary tabular-nums">
        {value}
      </dd>
    </Card>
  );
}

export function MarketsSandboxEmbeddedYield({ configureHref }: { configureHref: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const { selectedProjectId } = useDashboardWorkspace();
  const { state } = useMarketsSandbox(selectedProjectId);
  const { strategies } = useEarnStrategies({ cluster: "mainnet-beta" });
  const strategyById = new Map((strategies ?? []).map((strategy) => [strategy.id, strategy]));

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto flex w-full max-w-[63rem] flex-col gap-4 pt-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[19px] leading-6 font-medium text-primary">
                {t("DashboardMarkets.earnProgram.dashboardTitle")}
              </h2>
              <Badge variant="info">{t("DashboardMarkets.sandbox.localBadge")}</Badge>
            </div>
            <p className="mt-1 text-sm text-secondary">
              {t("DashboardMarkets.sandbox.embeddedDescription")}
            </p>
          </div>
          <Button asChild size="xs">
            <Link href={configureHref}>{t("DashboardMarkets.earnProgram.configureShort")}</Link>
          </Button>
        </div>

        <dl className="grid gap-2 sm:grid-cols-3">
          <Metric
            label={t("DashboardMarkets.earnProgram.customerWallets")}
            value={state.positions.length > 0 ? 1 : 0}
          />
          <Metric
            label={t("DashboardMarkets.earnProgram.livePositions")}
            value={state.positions.length}
          />
          <Metric
            label={t("DashboardMarkets.earnProgram.assetsEarning")}
            value={new Set(state.positions.map((position) => position.assetSymbol)).size}
          />
        </dl>

        {state.positions.length === 0 ? (
          <Card className="rounded-2xl">
            <ListEmptyState
              action={
                <Button asChild variant="secondary">
                  <Link href="/dashboard/markets/treasury-solutions">
                    {t("DashboardMarkets.sandbox.openTreasury")}
                  </Link>
                </Button>
              }
              description={t("DashboardMarkets.sandbox.embeddedEmptyDescription")}
              icon={<Layers3Icon aria-hidden="true" className="size-5" />}
              message={t("DashboardMarkets.earnProgram.introTitle")}
            />
          </Card>
        ) : (
          <Card className="overflow-hidden rounded-2xl">
            <CardHeader>
              <CardTitle>{t("DashboardMarkets.earnProgram.portfolioTitle")}</CardTitle>
              <CardDescription>
                {t("DashboardMarkets.sandbox.embeddedPortfolioDescription")}
              </CardDescription>
            </CardHeader>
            <div className="overflow-x-auto border-t border-border-subtle">
              <Table style={{ minWidth: "48rem" }}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("DashboardMarkets.earnProgram.strategy")}</TableHead>
                    <TableHead>{t("DashboardMarkets.earnProgram.asset")}</TableHead>
                    <TableHead>{t("DashboardMarkets.earnProgram.customerWallets")}</TableHead>
                    <TableHead>{t("DashboardMarkets.earnProgram.apy")}</TableHead>
                    <TableHead align="right">
                      {t("DashboardMarkets.earnProgram.liveValue")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.positions.map((position) => {
                    const strategy = strategyById.get(position.strategyId);
                    return (
                      <TableRow key={position.id}>
                        <TableCell>
                          <p className="text-sm text-primary">{position.strategyName}</p>
                          <p className="mt-0.5 text-xs text-tertiary">
                            {earnProviderLabel(position.provider)}
                          </p>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 text-sm text-primary">
                            <TokenMark
                              mint={position.assetMint}
                              size="sm"
                              symbol={position.assetSymbol}
                            />
                            {position.assetSymbol}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 text-sm text-primary">
                            <WalletIcon aria-hidden="true" className="size-4 text-tertiary" />1
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-primary tabular-nums">
                          {formatProviderApy(strategy?.currentApy, locale)}
                        </TableCell>
                        <TableCell align="right" className="text-sm text-primary tabular-nums">
                          {formatProviderAmount(position.amount, locale, position.assetSymbol)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
