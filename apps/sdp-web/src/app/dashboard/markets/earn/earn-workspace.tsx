"use client";

import { earnCuratorLabel } from "@sdp/types";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  EARN_RISK_TIERS,
  formatApy,
  formatTokenAmount,
  formatUsd,
  formatUsdCompact,
  getMockStrategy,
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
import {
  CURATOR_PROGRAMS,
  curatorApyRange,
  curatorProfileKey,
  programAssets,
  useLiquidityLabel,
} from "./earn-program-presentation";
import { EarnCuratorWithdrawModal, EarnWithdrawModal } from "./earn-withdraw-modal";

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

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

const CURATOR_ORDER = new Map(CURATOR_PROGRAMS.map((program, index) => [program.id, index]));

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

/** Shared collapsed-drawer summary styling for card-footer disclosures. */
function DrawerSummary({ children }: { children: React.ReactNode }) {
  return (
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-5 py-2.5 text-[13px] font-medium text-secondary transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
      {children}
      <ChevronDownIcon className="size-4 shrink-0 transition-transform duration-200 group-open/drawer:rotate-180 motion-reduce:transition-none" />
    </summary>
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
    <section className="rounded-xl border border-border-default bg-surface-raised p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-medium tracking-tight text-primary">
            {t("DashboardEarn.overview.positionsTitle")}
          </h2>
          <p className="mt-1 max-w-xl text-sm leading-6 text-secondary">
            {positions.length === 0
              ? t("DashboardEarn.overview.positionsEmpty")
              : t("DashboardEarn.overview.positionsDescription")}
          </p>
        </div>
        <Button asChild className="w-full sm:w-auto">
          <DashboardNavigationLink
            href="/dashboard/markets/earn/deposit"
            data-earn-withdraw-focus-fallback
          >
            <PlusIcon />
            {t("DashboardEarn.overview.newDeposit")}
          </DashboardNavigationLink>
        </Button>
      </div>

      {positions.length > 0 ? (
        <>
          <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-3">
            {statTiles.map((tile) => (
              <div key={tile.id} className="min-w-0 border-t border-border-subtle pt-3">
                <dt className="text-xs text-tertiary">{tile.label}</dt>
                <dd className="mt-1 text-2xl font-medium tracking-tight text-primary tabular-nums">
                  {formatUsd(tile.value)}
                </dd>
              </div>
            ))}
          </dl>

          <ul className="mt-6 grid gap-4">
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
                  <div className="p-5">
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
                        <dd className="mt-1 text-sm text-primary tabular-nums">
                          {formatUsd(group.deposited)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-tertiary">
                          {t("DashboardEarn.overview.estimatedValue")}
                        </dt>
                        <dd className="mt-1 text-sm text-primary tabular-nums">
                          {formatUsd(group.currentValue)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-tertiary">
                          {t("DashboardEarn.overview.indicativeBlendedApy")}
                        </dt>
                        <dd className="mt-1 text-sm text-primary tabular-nums">
                          {formatApy(String(blendedApy))}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <details className="sdp-collapse group/drawer border-t border-border-subtle">
                    <DrawerSummary>
                      <span>{t("DashboardEarn.overview.viewStrategyHoldings")}</span>
                    </DrawerSummary>
                    <ul className="divide-y divide-border-subtle border-t border-border-subtle">
                      {group.positions.map(({ position, strategy }) => (
                        <li
                          key={position.id}
                          className="grid gap-3 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
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
                            <p className="text-sm text-primary tabular-nums">
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
      ) : null}

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
    <section className="rounded-xl border border-border-default bg-surface-raised p-6">
      <h2 className="text-base font-medium tracking-tight text-primary">
        {t("DashboardEarn.overview.redemptionsTitle")}
      </h2>
      <p className="mt-1 max-w-xl text-sm leading-6 text-secondary">
        {t("DashboardEarn.overview.redemptionsDescription")}
      </p>
      <ul className="mt-4 divide-y divide-border-subtle rounded-lg border border-border-subtle">
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
                <p className="text-sm text-primary tabular-nums">
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

function ProgramMetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border-subtle py-2.5">
      <dt className="shrink-0 text-xs text-tertiary">{label}</dt>
      <dd className="text-right text-[13px] leading-5 text-primary">{value}</dd>
    </div>
  );
}

function CuratorProgramsSection() {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();

  return (
    <section>
      <div className="max-w-2xl">
        <h2 className="text-base font-medium tracking-tight text-primary">
          {t("DashboardEarn.overview.curatorsTitle")}
        </h2>
        <p className="mt-1 text-sm leading-6 text-secondary">
          {t("DashboardEarn.overview.curatorsDescription")}
        </p>
      </div>

      <div className="mt-5 grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
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
              className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-default bg-surface-raised transition-[border-color,box-shadow] duration-200 ease-out hover:border-border-strong hover:shadow-sm motion-reduce:transition-none"
            >
              <div className="flex flex-1 flex-col p-5">
                <h3 className="text-lg font-medium tracking-tight text-primary">{curatorName}</h3>
                <p className="mt-1 text-sm text-secondary">
                  {t(curatorProfileKey(program.id, "headline"))}
                </p>

                <p className="mt-6 text-2xl font-medium tracking-tight text-primary tabular-nums">
                  {curatorApyRange(program)}
                </p>
                <p className="mt-1 text-xs text-tertiary">
                  {t("DashboardEarn.overview.indicativeApyRange")}
                </p>

                <p className="mt-4 text-[13px] leading-5 text-tertiary">
                  {t(curatorProfileKey(program.id, "description"))}
                </p>

                <dl className="mt-6">
                  <ProgramMetaRow
                    label={t("DashboardEarn.overview.bestFor")}
                    value={t(curatorProfileKey(program.id, "bestFor"))}
                  />
                  <ProgramMetaRow label={t("DashboardEarn.overview.riskRange")} value={riskRange} />
                  <ProgramMetaRow
                    label={t("DashboardEarn.overview.liquidityRange")}
                    value={liquidities.join(" · ")}
                  />
                  <ProgramMetaRow
                    label={t("DashboardEarn.overview.fundingAssets")}
                    value={assets.join(", ")}
                  />
                </dl>
              </div>

              <details className="sdp-collapse group/drawer mt-auto border-t border-border-subtle">
                <DrawerSummary>
                  <span>
                    {t("DashboardEarn.overview.underlyingHoldings", {
                      count: program.strategies.length,
                    })}
                  </span>
                </DrawerSummary>
                <ul className="divide-y divide-border-subtle border-t border-border-subtle bg-fill-subtle/50">
                  {program.strategies.map((strategy) => (
                    <li key={strategy.id} className="px-5 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm text-primary">{strategy.name}</p>
                          <p className="mt-0.5 text-xs text-secondary">
                            {t(`DashboardEarn.source.${strategy.sourceKind}`)} ·{" "}
                            {t(`DashboardEarn.risk.${strategy.riskTier}`)}
                          </p>
                        </div>
                        <p className="shrink-0 text-sm text-primary tabular-nums">
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

              <div className="border-t border-border-subtle p-4">
                <Button asChild variant="secondary" className="w-full">
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
      <p className="mt-4 max-w-3xl text-xs leading-5 text-muted">
        {t("DashboardEarn.overview.programRateDisclosure")}
      </p>
    </section>
  );
}

export function EarnWorkspace() {
  const t = useTranslations();

  return (
    // No root padding: the dashboard shell already pads non-viewport-locked routes.
    <div className="grid content-start gap-6">
      <p className="text-xs leading-5 text-muted">{t("DashboardEarn.overview.mockNotice")}</p>
      <PositionsSection />
      <RedemptionsSection />
      <CuratorProgramsSection />
    </div>
  );
}
