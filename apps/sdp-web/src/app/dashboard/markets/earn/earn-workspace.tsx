"use client";

import {
  type EarnPortfolioPosition,
  type EarnPortfolioWalletStatus,
  type EarnStrategy,
  earnCuratorLabel,
} from "@sdp/types";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { formatApy, formatUsd, formatUsdCompact } from "./earn-format";
import { type EarnProgram, useEarnProgram, useEarnStrategies } from "./earn-program-data";
import {
  buildCuratorPrograms,
  curatorApyRange,
  curatorProfileKey,
  EARN_RISK_TIERS,
  programAssets,
  strategyCurator,
  strategyRiskTier,
  strategyTvlUsd,
  UNKNOWN_CURATOR_ID,
  useLiquidityLabel,
} from "./earn-program-presentation";
import { EarnWithdrawModal } from "./earn-withdraw-modal";

/** Group id for cash / in-transit slices that belong to no curator. */
const CASH_GROUP_ID = "__cash";

interface PositionEntry {
  position: EarnPortfolioPosition;
  strategy: EarnStrategy | undefined;
}

interface CuratorPositionGroup {
  id: string;
  entries: readonly PositionEntry[];
  valueUsd: number;
  /** Value-weighted APY across entries with a known rate, else undefined. */
  blendedApy: number | undefined;
}

/**
 * Group live portfolio positions by curator. Yield-source slices resolve
 * through the strategy catalogue (providerReference → riskMetadata.curator);
 * cash and in-transit slices collect into one trailing group so the list
 * always sums to the wallet total.
 */
function groupPositionsByCurator(
  positions: readonly EarnPortfolioPosition[],
  provider: string,
  strategies: readonly EarnStrategy[]
): readonly CuratorPositionGroup[] {
  const byReference = new Map(
    strategies
      .filter((strategy) => strategy.provider === provider)
      .map((strategy) => [strategy.providerReference, strategy] as const)
  );

  const accumulators = new Map<
    string,
    { entries: PositionEntry[]; valueUsd: number; apyValue: number; apyWeight: number }
  >();
  for (const position of positions) {
    const strategy =
      position.yieldSourceId !== undefined ? byReference.get(position.yieldSourceId) : undefined;
    const groupId =
      position.kind === "yield_source"
        ? strategy
          ? strategyCurator(strategy)
          : UNKNOWN_CURATOR_ID
        : CASH_GROUP_ID;

    const accumulator = accumulators.get(groupId) ?? {
      entries: [],
      valueUsd: 0,
      apyValue: 0,
      apyWeight: 0,
    };
    const valueUsd = Number(position.valueUsd);
    const apy = Number(strategy?.currentApy);
    accumulator.entries.push({ position, strategy });
    if (Number.isFinite(valueUsd)) {
      accumulator.valueUsd += valueUsd;
      if (Number.isFinite(apy)) {
        accumulator.apyValue += valueUsd * apy;
        accumulator.apyWeight += valueUsd;
      }
    }
    accumulators.set(groupId, accumulator);
  }

  return [...accumulators]
    .map(([id, { entries, valueUsd, apyValue, apyWeight }]) => ({
      id,
      entries,
      valueUsd,
      blendedApy: apyWeight > 0 ? apyValue / apyWeight : undefined,
    }))
    .sort((left, right) => {
      if ((left.id === CASH_GROUP_ID) !== (right.id === CASH_GROUP_ID)) {
        return left.id === CASH_GROUP_ID ? 1 : -1;
      }
      return right.valueUsd - left.valueUsd;
    });
}

const WALLET_STATUS_BADGES: Partial<
  Record<EarnPortfolioWalletStatus, { variant: "warning" | "danger"; key: MessageKey }>
> = {
  creating: { variant: "warning", key: "DashboardEarn.overview.walletStatusCreating" },
  busy: { variant: "warning", key: "DashboardEarn.overview.walletStatusBusy" },
  failed: { variant: "danger", key: "DashboardEarn.overview.walletStatusFailed" },
};

const SKELETON_ITEM_IDS = ["one", "two", "three"];

function PositionsSkeleton() {
  return (
    <div className="mt-6 grid gap-3" aria-busy="true">
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
        {SKELETON_ITEM_IDS.map((id) => (
          <SkeletonBlock key={id} className="h-16 w-full rounded-md" />
        ))}
      </div>
      <SkeletonBlock className="h-16 w-full rounded-xl" />
    </div>
  );
}

function PositionsSection() {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  const { state, error, isLoading, refresh } = useEarnProgram();
  const { strategies } = useEarnStrategies();
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const program = state?.kind === "active" ? state.program : undefined;
  const groups = useMemo(
    () =>
      program
        ? groupPositionsByCurator(program.wallet.positions, program.provider, strategies ?? [])
        : [],
    [program, strategies]
  );

  const description = program
    ? t("DashboardEarn.overview.positionsDescription")
    : state?.kind === "none"
      ? t("DashboardEarn.overview.positionsEmpty")
      : null;

  return (
    <section className="rounded-xl border border-border-default bg-surface-raised p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-medium tracking-tight text-primary">
              {t("DashboardEarn.overview.positionsTitle")}
            </h2>
            <WalletStatusBadge program={program} />
          </div>
          {description ? (
            <p className="mt-1 max-w-xl text-sm leading-6 text-secondary">{description}</p>
          ) : null}
        </div>
        <div className="flex w-full gap-2 sm:w-auto sm:shrink-0">
          {program ? (
            <>
              <Button
                variant="secondary"
                className="flex-1 sm:flex-none"
                disabled={Number(program.wallet.balance.withdrawableUsd) <= 0}
                onClick={() => setWithdrawOpen(true)}
              >
                {t("DashboardEarn.overview.withdraw")}
              </Button>
              <Button asChild variant="secondary" className="flex-1 sm:flex-none">
                <DashboardNavigationLink href="/dashboard/markets/earn/deposit?start=curator">
                  {t("DashboardEarn.overview.exploreCurators")}
                </DashboardNavigationLink>
              </Button>
            </>
          ) : null}
          <Button asChild className="flex-1 sm:flex-none">
            <DashboardNavigationLink
              href="/dashboard/markets/earn/deposit"
              data-earn-withdraw-focus-fallback
            >
              <PlusIcon />
              {t("DashboardEarn.overview.newDeposit")}
            </DashboardNavigationLink>
          </Button>
        </div>
      </div>

      {isLoading ? <PositionsSkeleton /> : null}

      {error ? (
        <div className="mt-4 flex items-center gap-3 rounded-md border border-border-subtle bg-fill-subtle p-3">
          <p className="flex-1 text-sm text-secondary">
            {t("DashboardEarn.overview.programLoadError")}
          </p>
          <Button size="sm" variant="secondary" onClick={refresh}>
            {t("Shared.SharedComponents.retry")}
          </Button>
        </div>
      ) : null}

      {state?.kind === "unconfigured" ? (
        <p className="mt-4 rounded-md border border-border-subtle bg-fill-subtle p-3 text-sm leading-6 text-secondary">
          {t("DashboardEarn.overview.providerNotConfigured")}
        </p>
      ) : null}

      {program ? (
        <>
          <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                id: "total",
                label: t("DashboardEarn.overview.totalBalance"),
                value: formatUsd(program.wallet.balance.totalUsd),
              },
              {
                id: "earned",
                label: t("DashboardEarn.overview.totalEarned"),
                value: formatUsd(program.wallet.balance.earnedUsd),
              },
              {
                id: "withdrawable",
                label: t("DashboardEarn.overview.withdrawableBalance"),
                value: formatUsd(program.wallet.balance.withdrawableUsd),
              },
              {
                id: "apy",
                label: t("DashboardEarn.overview.currentApy"),
                // Undefined rate (all-cash program, or a yield lookup that
                // failed) reads as "no rate yet" — never a misleading 0%.
                value: program.yield?.currentApy ? formatApy(program.yield.currentApy) : "—",
              },
            ].map((tile) => (
              <div key={tile.id} className="min-w-0 border-t border-border-subtle pt-3">
                <dt className="text-xs text-tertiary">{tile.label}</dt>
                <dd className="mt-1 text-2xl font-medium tracking-tight text-primary tabular-nums">
                  {tile.value}
                </dd>
              </div>
            ))}
          </dl>

          {groups.length > 0 ? (
            <ul className="mt-5 grid gap-2.5">
              {groups.map((group) => (
                <li key={group.id}>
                  <details className="sdp-collapse group/drawer overflow-hidden rounded-xl border border-border-default bg-surface-raised">
                    <summary className="flex min-h-16 cursor-pointer list-none items-center gap-4 px-5 py-3 transition-colors hover:bg-fill-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-primary">
                          {groupTitle(group.id, t)}
                        </p>
                        <p className="mt-0.5 text-xs text-tertiary">
                          {t("DashboardEarn.overview.holdingsCount", {
                            count: group.entries.length,
                          })}
                          {group.id === CASH_GROUP_ID
                            ? null
                            : ` · ${t("DashboardEarn.overview.curatorManaged")}`}
                        </p>
                      </div>
                      <div className="hidden items-baseline gap-5 tabular-nums sm:flex">
                        <span className="text-sm text-primary">{formatUsd(group.valueUsd)}</span>
                        <span className="w-14 text-right text-sm text-secondary">
                          {group.blendedApy !== undefined
                            ? formatApy(String(group.blendedApy))
                            : "—"}
                        </span>
                      </div>
                      <ChevronDownIcon className="size-4 shrink-0 text-tertiary transition-transform duration-200 group-open/drawer:rotate-180 motion-reduce:transition-none" />
                    </summary>
                    <ul className="divide-y divide-border-subtle border-t border-border-subtle">
                      {group.entries.map(({ position, strategy }) => (
                        <li
                          key={position.yieldSourceId ?? `${position.kind}:${position.label}`}
                          className="grid gap-3 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                        >
                          <div className="min-w-0">
                            <p className="text-sm text-primary">
                              {strategy?.name ?? position.label}
                            </p>
                            <p className="mt-0.5 text-xs leading-5 text-secondary">
                              {[
                                strategy ? liquidityLabel(strategy) : null,
                                position.token?.toUpperCase(),
                                position.pct !== undefined
                                  ? t("DashboardEarn.overview.portfolioShare", {
                                      pct: position.pct.toFixed(1),
                                    })
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </div>
                          <div className="sm:text-right">
                            <p className="text-sm text-primary tabular-nums">
                              {formatUsd(position.valueUsd)}
                            </p>
                            {strategy?.currentApy ? (
                              <p className="mt-0.5 text-xs text-secondary">
                                {formatApy(strategy.currentApy)}{" "}
                                {t(`DashboardEarn.apyType.${strategy.apyType}`)}
                              </p>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {withdrawOpen && program ? (
        <EarnWithdrawModal
          balance={program.wallet.balance}
          onClose={() => setWithdrawOpen(false)}
          onWithdrawalCreated={refresh}
        />
      ) : null}
    </section>
  );
}

function groupTitle(groupId: string, t: ReturnType<typeof useTranslations>): string {
  if (groupId === CASH_GROUP_ID) return t("DashboardEarn.overview.cashGroupTitle");
  if (groupId === UNKNOWN_CURATOR_ID) return t("DashboardEarn.overview.unknownCurator");
  return earnCuratorLabel(groupId);
}

function WalletStatusBadge({ program }: { program: EarnProgram | undefined }) {
  const t = useTranslations();
  const badge = program ? WALLET_STATUS_BADGES[program.wallet.status] : undefined;
  if (!badge) return null;
  return <Badge variant={badge.variant}>{t(badge.key)}</Badge>;
}

function ProgramMetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border-subtle py-2.5">
      <dt className="shrink-0 text-xs text-tertiary">{label}</dt>
      <dd className="text-right text-[13px] leading-5 text-primary">{value}</dd>
    </div>
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

/**
 * The live curator catalogue, shown as the onboarding hero only while there is
 * no active program. Once funds are in, curator discovery moves to the
 * "Explore curators" action in the positions header (curator-first deposit
 * flow), so the overview stays focused on the portfolio.
 */
function CuratorProgramsSection() {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  const { state } = useEarnProgram();
  const { strategies, error, isLoading } = useEarnStrategies();

  if (state?.kind === "active") {
    return null;
  }

  const programs = buildCuratorPrograms(strategies ?? []);

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

      {isLoading ? (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          {SKELETON_ITEM_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-96 w-full rounded-xl" />
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="mt-5 text-sm leading-6 text-secondary">
          {t("DashboardEarn.overview.curatorsLoadError")}
        </p>
      ) : null}

      {!isLoading && !error && programs.length === 0 ? (
        <p className="mt-5 text-sm leading-6 text-secondary">
          {t("DashboardEarn.overview.curatorsEmpty")}
        </p>
      ) : null}

      <div className="mt-5 grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
        {programs.map((program) => {
          const knownTiers = EARN_RISK_TIERS.filter((tier) =>
            program.strategies.some((strategy) => strategyRiskTier(strategy) === tier)
          );
          const riskRange =
            knownTiers.length === 0
              ? t(curatorProfileKey(program.id, "risk"))
              : knownTiers.length === 1
                ? t(`DashboardEarn.risk.${knownTiers[0]}`)
                : `${t(`DashboardEarn.risk.${knownTiers[0]}`)}–${t(
                    `DashboardEarn.risk.${knownTiers[knownTiers.length - 1]}`
                  )}`;
          const liquidities = [
            ...new Set(program.strategies.map((strategy) => liquidityLabel(strategy))),
          ];
          const assets = programAssets(program.strategies);
          const curatorName =
            program.id === UNKNOWN_CURATOR_ID
              ? t("DashboardEarn.overview.unknownCurator")
              : earnCuratorLabel(program.id);

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
                  {program.strategies.map((strategy) => {
                    const tier = strategyRiskTier(strategy);
                    const tvlUsd = strategyTvlUsd(strategy);
                    return (
                      <li key={strategy.id} className="px-5 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm text-primary">{strategy.name}</p>
                            <p className="mt-0.5 text-xs text-secondary">
                              {[
                                t(`DashboardEarn.source.${strategy.sourceKind}`),
                                tier ? t(`DashboardEarn.risk.${tier}`) : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </div>
                          <p className="shrink-0 text-sm text-primary tabular-nums">
                            {formatApy(strategy.currentApy)}
                          </p>
                        </div>
                        <p className="mt-2 text-xs leading-5 text-tertiary">
                          {[
                            liquidityLabel(strategy),
                            programAssets([strategy]).join(", "),
                            tvlUsd !== undefined
                              ? t("DashboardEarn.overview.tvl", {
                                  value: formatUsdCompact(tvlUsd),
                                })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </li>
                    );
                  })}
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
      {programs.length > 0 ? (
        <p className="mt-4 max-w-3xl text-xs leading-5 text-muted">
          {t("DashboardEarn.overview.programRateDisclosure")}
        </p>
      ) : null}
    </section>
  );
}

export function EarnWorkspace() {
  return (
    // No root padding: the dashboard shell already pads non-viewport-locked routes.
    <div className="grid content-start gap-6">
      <PositionsSection />
      <CuratorProgramsSection />
    </div>
  );
}
