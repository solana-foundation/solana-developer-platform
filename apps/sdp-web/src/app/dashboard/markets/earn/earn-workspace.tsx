"use client";

import { earnCuratorLabel } from "@sdp/types";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { buildCuratorPrograms } from "./deposit/earn-setup-model";
import {
  EARN_RISK_TIERS,
  formatApy,
  formatTokenAmount,
  formatUsd,
  formatUsdCompact,
  getMockStrategy,
  MOCK_EARN_STRATEGIES,
  type MockEarnStrategy,
  projectYearlyYield,
  tokenSymbol,
} from "./earn-mock-data";
import {
  clearMockRedemption,
  type MockEarnPosition,
  useMockEarnPositions,
  useMockEarnRedemptions,
} from "./earn-mock-positions";
import { EarnCuratorWithdrawModal, EarnWithdrawModal } from "./earn-withdraw-modal";

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
const KNOWN_CURATOR_PROFILE_IDS = new Set(["steakhouse", "gauntlet", "sentora"]);

interface CuratorPositionGroup {
  curatorId: string;
  positions: readonly {
    position: MockEarnPosition;
    strategy: MockEarnStrategy | undefined;
  }[];
  deposited: number;
  currentValue: number;
  projectedYearlyYield: number;
}

const CURATOR_PROGRAMS = buildCuratorPrograms(MOCK_EARN_STRATEGIES);
const CURATOR_ORDER = new Map(CURATOR_PROGRAMS.map((program, index) => [program.id, index]));

function curatorProfileKey(
  curatorId: string,
  field: "headline" | "description" | "bestFor"
): MessageKey {
  const profileId = KNOWN_CURATOR_PROFILE_IDS.has(curatorId) ? curatorId : "default";
  return `DashboardEarn.setup.curatorProfiles.${profileId}.${field}` as MessageKey;
}

function formatProgramApy(strategies: readonly MockEarnStrategy[]): string {
  const rates = strategies
    .map((strategy) => Number(strategy.currentApy))
    .filter((rate) => Number.isFinite(rate));
  if (rates.length === 0) return "—";
  const minimum = Math.min(...rates);
  const maximum = Math.max(...rates);
  if (minimum === maximum) return formatApy(String(minimum));
  return `${formatApy(String(minimum))}–${formatApy(String(maximum))}`;
}

function programAssets(strategies: readonly MockEarnStrategy[]): string[] {
  return [
    ...new Set(
      strategies.flatMap((strategy) => strategy.depositMints.map((mint) => tokenSymbol(mint)))
    ),
  ];
}

function useLiquidityLabel() {
  const t = useTranslations();
  return (strategy: MockEarnStrategy): string => {
    if (strategy.liquidityTerm === "instant") {
      return t("DashboardEarn.liquidity.instant");
    }
    const days = strategy.redemptionDelayDays ?? 1;
    if (strategy.intradayFraction) {
      return t("DashboardEarn.liquidity.mixed", {
        pct: Math.round(strategy.intradayFraction * 100),
        days,
      });
    }
    return t("DashboardEarn.liquidity.delayed", { days });
  };
}

/** Estimated current value with simple-interest accrual since the deposit. */
function estimatePositionValue(position: MockEarnPosition): number {
  const strategy = getMockStrategy(position.strategyId);
  const rate = Number(strategy?.currentApy ?? 0);
  const elapsedYears = Math.max(0, Date.now() - Date.parse(position.createdAt)) / MS_PER_YEAR;
  return position.amount * (1 + rate * elapsedYears);
}

function groupPositionsByCurator(
  positions: readonly MockEarnPosition[]
): readonly CuratorPositionGroup[] {
  const groups = new Map<string, CuratorPositionGroup>();
  for (const position of positions) {
    const strategy = getMockStrategy(position.strategyId);
    const curatorId = strategy?.curator ?? "unknown";
    const existing = groups.get(curatorId) ?? {
      curatorId,
      positions: [],
      deposited: 0,
      currentValue: 0,
      projectedYearlyYield: 0,
    };
    groups.set(curatorId, {
      ...existing,
      positions: [...existing.positions, { position, strategy }],
      deposited: existing.deposited + position.amount,
      currentValue: existing.currentValue + estimatePositionValue(position),
      projectedYearlyYield:
        existing.projectedYearlyYield + projectYearlyYield(position.amount, strategy?.currentApy),
    });
  }
  return [...groups.values()].sort(
    (left, right) =>
      (CURATOR_ORDER.get(left.curatorId) ?? Number.MAX_SAFE_INTEGER) -
      (CURATOR_ORDER.get(right.curatorId) ?? Number.MAX_SAFE_INTEGER)
  );
}

function PositionsSection() {
  const t = useTranslations();
  const locale = useLocale();
  const positions = useMockEarnPositions();
  const liquidityLabel = useLiquidityLabel();
  const [withdrawTarget, setWithdrawTarget] = useState<MockEarnPosition | null>(null);
  const [withdrawCuratorId, setWithdrawCuratorId] = useState<string | null>(null);
  const withdrawStrategy = withdrawTarget ? getMockStrategy(withdrawTarget.strategyId) : undefined;

  const groups = useMemo(() => groupPositionsByCurator(positions), [positions]);
  const withdrawGroup = withdrawCuratorId
    ? groups.find((group) => group.curatorId === withdrawCuratorId)
    : undefined;
  const totals = useMemo(
    () =>
      groups.reduce(
        (total, group) => ({
          deposited: total.deposited + group.deposited,
          value: total.value + group.currentValue,
          projected: total.projected + group.projectedYearlyYield,
        }),
        { deposited: 0, value: 0, projected: 0 }
      ),
    [groups]
  );

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium text-primary">
            {t("DashboardEarn.overview.positionsTitle")}
          </h2>
          <p className="mt-1 text-sm text-secondary">
            {t("DashboardEarn.overview.positionsDescription")}
          </p>
        </div>
        <Button asChild size="sm" className="w-full sm:w-auto">
          <DashboardNavigationLink
            href="/dashboard/markets/earn/deposit"
            data-earn-withdraw-focus-fallback
          >
            <PlusIcon />
            {t("DashboardEarn.overview.newDeposit")}
          </DashboardNavigationLink>
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

          <ul className="mt-3 grid gap-3">
            {groups.map((group) => {
              const curatorName =
                group.curatorId === "unknown"
                  ? t("DashboardEarn.overview.unknownCurator")
                  : earnCuratorLabel(group.curatorId);
              const blendedApy =
                group.deposited > 0 ? group.projectedYearlyYield / group.deposited : 0;
              return (
                <li
                  key={group.curatorId}
                  className="overflow-hidden rounded-xl border border-border-default bg-surface-raised"
                >
                  <div className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-medium text-primary">{curatorName}</h3>
                        <p className="mt-0.5 text-xs text-tertiary">
                          {t("DashboardEarn.overview.holdingsCount", {
                            count: group.positions.length,
                          })}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-secondary">
                          {t("DashboardEarn.overview.curatorManaged")}
                        </p>
                        {group.curatorId !== "unknown" &&
                        group.positions.every((entry) => entry.strategy !== undefined) ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-label={t("DashboardEarn.overview.withdrawFromCurator", {
                              curator: curatorName,
                            })}
                            onClick={() => setWithdrawCuratorId(group.curatorId)}
                          >
                            {t("DashboardEarn.overview.withdraw")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                      <div>
                        <dt className="text-xs text-tertiary">
                          {t("DashboardEarn.overview.totalDeposited")}
                        </dt>
                        <dd className="mt-1 text-sm text-primary">{formatUsd(group.deposited)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-tertiary">
                          {t("DashboardEarn.overview.estimatedValue")}
                        </dt>
                        <dd className="mt-1 text-sm text-primary">
                          {formatUsd(group.currentValue)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-tertiary">
                          {t("DashboardEarn.overview.indicativeBlendedApy")}
                        </dt>
                        <dd className="mt-1 text-sm text-primary">
                          {formatApy(String(blendedApy))}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <details className="group border-t border-border-subtle">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
                      <span>{t("DashboardEarn.overview.viewStrategyHoldings")}</span>
                      <ChevronDownIcon className="size-4 shrink-0 text-secondary transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" />
                    </summary>
                    <ul className="divide-y divide-border-subtle border-t border-border-subtle">
                      {group.positions.map(({ position, strategy }) => (
                        <li
                          key={position.id}
                          className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
                        >
                          <div className="min-w-0">
                            <p className="text-sm text-primary">
                              {strategy?.name ?? position.strategyId}
                            </p>
                            <p className="mt-0.5 text-xs leading-5 text-secondary">
                              {formatTokenAmount(position.amount, position.tokenMint)} ·{" "}
                              {strategy ? liquidityLabel(strategy) : null} ·{" "}
                              {t("DashboardEarn.overview.depositedOn", {
                                date: new Date(position.createdAt).toLocaleDateString(locale, {
                                  month: "short",
                                  day: "numeric",
                                }),
                              })}
                            </p>
                          </div>
                          <div className="sm:text-right">
                            <p className="text-sm text-primary">
                              {formatUsd(estimatePositionValue(position))}
                            </p>
                            <p className="mt-0.5 text-xs text-secondary">
                              {formatApy(strategy?.currentApy)}{" "}
                              {t("DashboardEarn.apyType.variable")}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full sm:w-auto"
                            aria-label={t("DashboardEarn.overview.withdrawFromHolding", {
                              holding: strategy?.name ?? position.strategyId,
                            })}
                            disabled={!strategy}
                            onClick={() => setWithdrawTarget(position)}
                          >
                            {t("DashboardEarn.overview.withdraw")}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </details>
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
      {withdrawGroup && withdrawGroup.curatorId !== "unknown" ? (
        <EarnCuratorWithdrawModal
          curatorId={withdrawGroup.curatorId}
          curatorName={earnCuratorLabel(withdrawGroup.curatorId)}
          onClose={() => setWithdrawCuratorId(null)}
        />
      ) : null}
    </section>
  );
}

function RedemptionsSection() {
  const t = useTranslations();
  const locale = useLocale();
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
          const curatorName = strategy
            ? earnCuratorLabel(strategy.curator)
            : t("DashboardEarn.overview.unknownCurator");
          const settled = Date.parse(redemption.availableAt) <= Date.now();
          return (
            <li
              key={redemption.id}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm text-primary">{curatorName}</p>
                <p className="mt-0.5 text-xs leading-5 text-secondary">
                  {strategy?.name ?? redemption.strategyId} ·{" "}
                  {t("DashboardEarn.overview.redemptionRequested", {
                    date: new Date(redemption.requestedAt).toLocaleDateString(locale, {
                      month: "short",
                      day: "numeric",
                    }),
                  })}{" "}
                  ·{" "}
                  {t("DashboardEarn.overview.redemptionAvailable", {
                    date: new Date(redemption.availableAt).toLocaleDateString(locale, {
                      month: "short",
                      day: "numeric",
                    }),
                  })}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 sm:justify-end">
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
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CuratorProgramsSection() {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();

  return (
    <section className="rounded-lg border border-border-default bg-surface-raised p-4">
      <h2 className="text-sm font-medium text-primary">
        {t("DashboardEarn.overview.curatorsTitle")}
      </h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-secondary">
        {t("DashboardEarn.overview.curatorsDescription")}
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {CURATOR_PROGRAMS.map((program) => {
          const riskTiers = EARN_RISK_TIERS.filter((tier) =>
            program.strategies.some((strategy) => strategy.riskTier === tier)
          );
          const riskRange =
            riskTiers.length === 1
              ? t(`DashboardEarn.risk.${riskTiers[0]}`)
              : `${t(`DashboardEarn.risk.${riskTiers[0]}`)}–${t(
                  `DashboardEarn.risk.${riskTiers[riskTiers.length - 1]}`
                )}`;
          const liquidities = [
            ...new Set(program.strategies.map((strategy) => liquidityLabel(strategy))),
          ];
          const assets = programAssets(program.strategies);
          const curatorName = earnCuratorLabel(program.id);

          return (
            <article
              key={program.id}
              className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-default bg-surface-raised"
            >
              <div className="flex flex-1 flex-col p-4">
                <p className="text-xs font-medium text-tertiary">
                  {t("DashboardEarn.overview.curatorLabel")}
                </p>
                <h3 className="mt-1 text-base font-medium text-primary">{curatorName}</h3>
                <p className="mt-2 text-sm font-medium leading-5 text-primary">
                  {t(curatorProfileKey(program.id, "headline"))}
                </p>
                <p className="mt-1 text-[13px] leading-5 text-secondary">
                  {t(curatorProfileKey(program.id, "description"))}
                </p>

                <div className="mt-4 rounded-lg bg-fill-subtle px-3 py-2.5">
                  <p className="text-xs text-tertiary">{t("DashboardEarn.overview.bestFor")}</p>
                  <p className="mt-0.5 text-[13px] leading-5 text-primary">
                    {t(curatorProfileKey(program.id, "bestFor"))}
                  </p>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                  <div>
                    <dt className="text-xs text-tertiary">
                      {t("DashboardEarn.overview.indicativeApyRange")}
                    </dt>
                    <dd className="mt-1 text-sm text-primary">
                      {formatProgramApy(program.strategies)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-tertiary">
                      {t("DashboardEarn.overview.riskRange")}
                    </dt>
                    <dd className="mt-1 text-sm text-primary">{riskRange}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-tertiary">
                      {t("DashboardEarn.overview.liquidityRange")}
                    </dt>
                    <dd className="mt-1 text-sm leading-5 text-primary">
                      {liquidities.join(" · ")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-tertiary">
                      {t("DashboardEarn.overview.fundingAssets")}
                    </dt>
                    <dd className="mt-1 text-sm leading-5 text-primary">{assets.join(", ")}</dd>
                  </div>
                </dl>
              </div>

              <details className="group border-t border-border-subtle">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
                  <span>
                    {t("DashboardEarn.overview.underlyingHoldings", {
                      count: program.strategies.length,
                    })}
                  </span>
                  <ChevronDownIcon className="size-4 shrink-0 text-secondary transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" />
                </summary>
                <ul className="divide-y divide-border-subtle border-t border-border-subtle bg-fill-subtle/50">
                  {program.strategies.map((strategy) => (
                    <li key={strategy.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm text-primary">{strategy.name}</p>
                          <p className="mt-0.5 text-xs text-secondary">
                            {t(`DashboardEarn.source.${strategy.sourceKind}`)} ·{" "}
                            {t(`DashboardEarn.risk.${strategy.riskTier}`)}
                          </p>
                        </div>
                        <p className="shrink-0 text-sm text-primary">
                          {formatApy(strategy.currentApy)}
                        </p>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-tertiary">
                        {liquidityLabel(strategy)} ·{" "}
                        {strategy.depositMints.map((mint) => tokenSymbol(mint)).join(", ")} ·{" "}
                        {t("DashboardEarn.overview.tvl", {
                          value: formatUsdCompact(strategy.tvlUsd),
                        })}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>

              <div className="p-4">
                <Button asChild className="w-full">
                  <DashboardNavigationLink
                    href={`/dashboard/markets/earn/deposit?curator=${encodeURIComponent(program.id)}`}
                  >
                    {t("DashboardEarn.overview.startWithCurator", { curator: curatorName })}
                  </DashboardNavigationLink>
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      <p className="mt-4 text-xs leading-5 text-tertiary">
        {t("DashboardEarn.overview.programRateDisclosure")}
      </p>
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
      <CuratorProgramsSection />
    </div>
  );
}
