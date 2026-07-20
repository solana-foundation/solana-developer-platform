"use client";

import type { EarnStrategySourceKind } from "@sdp/types";
import { earnCuratorLabel } from "@sdp/types";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import { cn } from "@/lib/utils";
import {
  formatApy,
  formatTokenAmount,
  formatUsd,
  formatUsdCompact,
  getMockStrategy,
  MOCK_EARN_STRATEGIES,
  type MockEarnStrategy,
  projectYearlyYield,
} from "./earn-mock-data";
import {
  clearMockRedemption,
  type MockEarnPosition,
  useMockEarnPositions,
  useMockEarnRedemptions,
} from "./earn-mock-positions";
import { EarnWithdrawModal } from "./earn-withdraw-modal";

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-on-primary"
          : "border-border-default bg-surface-raised text-secondary hover:text-primary"
      )}
    >
      {children}
    </button>
  );
}

function useLiquidityLabel() {
  const t = useTranslations();
  return (strategy: MockEarnStrategy): string =>
    strategy.liquidityTerm === "instant"
      ? t("DashboardEarn.liquidity.instant")
      : t("DashboardEarn.liquidity.delayed", { days: strategy.redemptionDelayDays ?? 1 });
}

/** Estimated current value with simple-interest accrual since the deposit. */
function estimatePositionValue(position: MockEarnPosition): number {
  const strategy = getMockStrategy(position.strategyId);
  const rate = Number(strategy?.currentApy ?? 0);
  const elapsedYears = Math.max(0, Date.now() - Date.parse(position.createdAt)) / MS_PER_YEAR;
  return position.amount * (1 + rate * elapsedYears);
}

function PositionsSection() {
  const t = useTranslations();
  const router = useDashboardRouter();
  const positions = useMockEarnPositions();
  const liquidityLabel = useLiquidityLabel();
  const [withdrawTarget, setWithdrawTarget] = useState<MockEarnPosition | null>(null);
  const withdrawStrategy = withdrawTarget ? getMockStrategy(withdrawTarget.strategyId) : undefined;

  const totals = useMemo(() => {
    let deposited = 0;
    let value = 0;
    let projected = 0;
    for (const position of positions) {
      const strategy = getMockStrategy(position.strategyId);
      deposited += position.amount;
      value += estimatePositionValue(position);
      projected += projectYearlyYield(position.amount, strategy?.currentApy);
    }
    return { deposited, value, projected };
  }, [positions]);

  const statTiles = [
    { id: "deposited", label: t("DashboardEarn.overview.totalDeposited"), value: totals.deposited },
    { id: "value", label: t("DashboardEarn.overview.estimatedValue"), value: totals.value },
    {
      id: "projected",
      label: t("DashboardEarn.overview.projectedYearlyYield"),
      value: totals.projected,
    },
  ];

  return (
    <section className="rounded-lg border border-border-default bg-surface-raised p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-primary">
          {t("DashboardEarn.overview.positionsTitle")}
        </h2>
        <Button
          size="sm"
          iconLeft={<PlusIcon />}
          onClick={() => router.push("/dashboard/earn/deposit")}
        >
          {t("DashboardEarn.overview.newDeposit")}
        </Button>
      </div>

      {positions.length === 0 ? (
        <p className="mt-4 text-sm text-tertiary">{t("DashboardEarn.overview.positionsEmpty")}</p>
      ) : (
        <>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {statTiles.map((tile) => (
              <div key={tile.id} className="rounded-md border border-border-default p-3">
                <p className="text-xs text-secondary">{tile.label}</p>
                <p className="mt-1 text-lg font-medium text-primary">{formatUsd(tile.value)}</p>
              </div>
            ))}
          </div>

          <ul className="mt-3 divide-y divide-border-default rounded-md border border-border-default">
            {positions.map((position) => {
              const strategy = getMockStrategy(position.strategyId);
              return (
                <li key={position.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-primary">{strategy?.name ?? position.strategyId}</p>
                    <p className="mt-0.5 text-xs text-secondary">
                      {formatTokenAmount(position.amount, position.tokenMint)} ·{" "}
                      {strategy ? liquidityLabel(strategy) : null} ·{" "}
                      {t("DashboardEarn.overview.depositedOn", {
                        date: new Date(position.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        }),
                      })}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-primary">
                      {formatUsd(estimatePositionValue(position))}
                    </p>
                    <p className="mt-0.5 text-xs text-secondary">
                      {formatApy(strategy?.currentApy)} {t("DashboardEarn.apyType.variable")}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => setWithdrawTarget(position)}>
                    {t("DashboardEarn.overview.withdraw")}
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {withdrawTarget && withdrawStrategy ? (
        <EarnWithdrawModal
          position={withdrawTarget}
          strategy={withdrawStrategy}
          onClose={() => setWithdrawTarget(null)}
        />
      ) : null}
    </section>
  );
}

function RedemptionsSection() {
  const t = useTranslations();
  const redemptions = useMockEarnRedemptions();

  if (redemptions.length === 0) {
    return null;
  }

  return (
    <section className="rounded-lg border border-border-default bg-surface-raised p-4">
      <h2 className="text-sm font-medium text-primary">
        {t("DashboardEarn.overview.redemptionsTitle")}
      </h2>
      <p className="mt-1 text-sm text-secondary">
        {t("DashboardEarn.overview.redemptionsDescription")}
      </p>
      <ul className="mt-3 divide-y divide-border-default rounded-md border border-border-default">
        {redemptions.map((redemption) => {
          const strategy = getMockStrategy(redemption.strategyId);
          const settled = Date.parse(redemption.availableAt) <= Date.now();
          return (
            <li key={redemption.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-primary">{strategy?.name ?? redemption.strategyId}</p>
                <p className="mt-0.5 text-xs text-secondary">
                  {t("DashboardEarn.overview.redemptionRequested", {
                    date: new Date(redemption.requestedAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    }),
                  })}{" "}
                  ·{" "}
                  {t("DashboardEarn.overview.redemptionAvailable", {
                    date: new Date(redemption.availableAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    }),
                  })}
                </p>
              </div>
              <p className="text-sm text-primary">
                {formatTokenAmount(redemption.amount, redemption.tokenMint)}
              </p>
              <Badge variant={settled ? "success" : "warning"}>
                {settled
                  ? t("DashboardEarn.overview.redemptionSettled")
                  : t("DashboardEarn.overview.redemptionPending")}
              </Badge>
              {settled ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => clearMockRedemption(redemption.id)}
                >
                  {t("DashboardEarn.overview.redemptionClear")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StrategiesSection() {
  const t = useTranslations();
  const router = useDashboardRouter();
  const liquidityLabel = useLiquidityLabel();
  const [sourceFilter, setSourceFilter] = useState<EarnStrategySourceKind | null>(null);

  const strategies = sourceFilter
    ? MOCK_EARN_STRATEGIES.filter((strategy) => strategy.sourceKind === sourceFilter)
    : MOCK_EARN_STRATEGIES;

  return (
    <section className="rounded-lg border border-border-default bg-surface-raised p-4">
      <h2 className="text-sm font-medium text-primary">
        {t("DashboardEarn.overview.strategiesTitle")}
      </h2>
      <p className="mt-1 text-sm text-secondary">
        {t("DashboardEarn.overview.strategiesDescription")}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <FilterChip active={sourceFilter === null} onClick={() => setSourceFilter(null)}>
          {t("DashboardEarn.overview.filterAll")}
        </FilterChip>
        <FilterChip active={sourceFilter === "defi"} onClick={() => setSourceFilter("defi")}>
          {t("DashboardEarn.source.defi")}
        </FilterChip>
        <FilterChip active={sourceFilter === "rwa"} onClick={() => setSourceFilter("rwa")}>
          {t("DashboardEarn.source.rwa")}
        </FilterChip>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border-default">
        <table className="w-full min-w-[720px] table-fixed border-collapse">
          <thead>
            <tr className="border-b border-border-default">
              <th className="w-[30%] px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-secondary">
                {t("DashboardEarn.overview.columnStrategy")}
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-secondary">
                {t("DashboardEarn.overview.columnCurator")}
              </th>
              <th className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-secondary">
                {t("DashboardEarn.overview.columnApy")}
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-secondary">
                {t("DashboardEarn.overview.columnLiquidity")}
              </th>
              <th className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-secondary">
                {t("DashboardEarn.overview.columnTvl")}
              </th>
              <th className="w-28 px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-secondary">
                <span className="sr-only">{t("DashboardEarn.overview.columnActions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((strategy) => (
              <tr key={strategy.id} className="border-b border-border-default last:border-b-0">
                <td className="px-4 py-3">
                  <p className="truncate text-sm text-primary">{strategy.name}</p>
                  <p className="mt-0.5 text-xs text-secondary">
                    {t(`DashboardEarn.source.${strategy.sourceKind}`)} ·{" "}
                    {t(`DashboardEarn.risk.${strategy.riskTier}`)}
                  </p>
                </td>
                <td className="px-4 py-3 text-sm text-primary">
                  {earnCuratorLabel(strategy.curator)}
                </td>
                <td className="px-4 py-3 text-right text-sm text-primary">
                  {formatApy(strategy.currentApy)}
                  <span className="ml-1 text-xs text-secondary">
                    {t(`DashboardEarn.apyType.${strategy.apyType}`)}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-primary">{liquidityLabel(strategy)}</td>
                <td className="px-4 py-3 text-right text-sm text-primary">
                  {formatUsdCompact(strategy.tvlUsd)}
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      router.push(
                        `/dashboard/earn/deposit?strategy=${encodeURIComponent(strategy.id)}`
                      )
                    }
                  >
                    {t("DashboardEarn.overview.deposit")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function EarnWorkspace() {
  const t = useTranslations();

  return (
    // No root padding: the dashboard shell already pads non-viewport-locked routes.
    <div className="grid content-start gap-4">
      <p className="text-xs text-tertiary">{t("DashboardEarn.overview.mockNotice")}</p>
      <PositionsSection />
      <RedemptionsSection />
      <StrategiesSection />
    </div>
  );
}
