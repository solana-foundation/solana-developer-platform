"use client";

import {
  EARN_STRATEGY_SOURCE_KINDS,
  type EarnPortfolioToken,
  type EarnStrategy,
  type EarnStrategySourceKind,
} from "@sdp/types";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { formatApy, formatUsdCompact } from "../earn-format";
import {
  strategyCuratorLabel,
  strategyPoolUsd,
  strategySourceLabel,
  strategyToken,
  useLiquidityLabel,
} from "../earn-program-presentation";
import {
  SelectableCard,
  SelectionAnnouncement,
  SelectionMark,
  StepListSkeleton,
  StepNotice,
} from "./earn-deposit-chrome";
import {
  EARN_SHORT_SETTLEMENT_DAYS,
  EARN_STRATEGY_SORTS,
  type EarnStrategyFilters,
  type EarnStrategySort,
} from "./earn-deposit-model";

/** Sentinel for "no constraint" in the single-select filter controls. */
const ANY = "any";

const SORT_LABEL_KEYS = {
  apy: "DashboardEarn.deposit.sortApy",
  size: "DashboardEarn.deposit.sortSize",
  access: "DashboardEarn.deposit.sortAccess",
} as const satisfies Record<EarnStrategySort, string>;

/** Access filter values, mapped to the model's `maxSettlementDays`. */
const ACCESS_OPTIONS = [
  { value: ANY, days: null, labelKey: "DashboardEarn.deposit.filterAccessAny" },
  { value: "instant", days: 0, labelKey: "DashboardEarn.deposit.filterAccessInstant" },
  {
    value: "short",
    days: EARN_SHORT_SETTLEMENT_DAYS,
    labelKey: "DashboardEarn.deposit.filterAccessThreeDays",
  },
] as const;

function accessValue(maxSettlementDays: number | null): string {
  const match = ACCESS_OPTIONS.find((option) => option.days === maxSettlementDays);
  // A profile floor that is not one of the chips (or a value from a future
  // preset) still renders honestly as "any" rather than silently snapping.
  return match?.value ?? ANY;
}

function FilterBar({
  filters,
  onChange,
  onReset,
  resultCount,
  tokens,
}: {
  filters: EarnStrategyFilters;
  onChange: (next: EarnStrategyFilters) => void;
  onReset: () => void;
  resultCount: number;
  tokens: readonly EarnPortfolioToken[];
}) {
  const t = useTranslations();

  return (
    <div className="rounded-2xl border border-border-default bg-surface-raised p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 xl:auto-cols-fr">
        <Select
          ariaLabel={t("DashboardEarn.deposit.filterAccess")}
          onValueChange={(value) => {
            const option = ACCESS_OPTIONS.find((entry) => entry.value === value);
            onChange({ ...filters, maxSettlementDays: option?.days ?? null });
          }}
          value={accessValue(filters.maxSettlementDays)}
        >
          {ACCESS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </SelectItem>
          ))}
        </Select>

        <Select
          ariaLabel={t("DashboardEarn.deposit.filterBacking")}
          onValueChange={(value) =>
            onChange({
              ...filters,
              sourceKind: value === ANY ? null : (value as EarnStrategySourceKind),
            })
          }
          value={filters.sourceKind ?? ANY}
        >
          <SelectItem value={ANY}>{t("DashboardEarn.deposit.filterBackingAny")}</SelectItem>
          {EARN_STRATEGY_SOURCE_KINDS.map((kind) => (
            <SelectItem key={kind} value={kind}>
              {t(`DashboardEarn.source.${kind}`)}
            </SelectItem>
          ))}
        </Select>

        {/* Token options come from the catalogue, and the control only appears
            when there is a real choice: the dashboard reads the sandbox
            catalogue, where USDT has no Solana mint and every source is USDC —
            a lone chip would read as a broken control. */}
        {tokens.length > 1 ? (
          <Select
            ariaLabel={t("DashboardEarn.deposit.filterToken")}
            onValueChange={(value) =>
              onChange({ ...filters, token: value === ANY ? null : (value as EarnPortfolioToken) })
            }
            value={filters.token ?? ANY}
          >
            <SelectItem value={ANY}>{t("DashboardEarn.deposit.filterTokenAny")}</SelectItem>
            {tokens.map((token) => (
              <SelectItem key={token} value={token}>
                {token.toUpperCase()}
              </SelectItem>
            ))}
          </Select>
        ) : null}

        <Select
          ariaLabel={t("DashboardEarn.deposit.filterSort")}
          onValueChange={(value) => onChange({ ...filters, sort: value as EarnStrategySort })}
          value={filters.sort}
        >
          {EARN_STRATEGY_SORTS.map((sort) => (
            <SelectItem key={sort} value={sort}>
              {t(SORT_LABEL_KEYS[sort])}
            </SelectItem>
          ))}
        </Select>
      </div>

      <div className="mt-3 flex min-h-9 items-center justify-between gap-3 border-t border-border-subtle pt-3">
        <p aria-live="polite" className="text-xs text-tertiary">
          {t("DashboardEarn.deposit.resultCount", { count: resultCount })}
        </p>
        <Button
          iconLeft={<RotateCcwIcon />}
          onClick={onReset}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("DashboardEarn.deposit.clearFilters")}
        </Button>
      </div>
    </div>
  );
}

function StrategyCard({
  onSelect,
  selected,
  showTokenChip,
  strategy,
}: {
  onSelect: () => void;
  selected: boolean;
  showTokenChip: boolean;
  strategy: EarnStrategy;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  const inputId = `earn-strategy-${strategy.id}`;
  const nameId = `${inputId}-name`;
  const detailId = `${inputId}-detail`;
  const token = strategyToken(strategy);
  const poolUsd = strategyPoolUsd(strategy);
  const sourceLabel = strategySourceLabel(strategy);
  const curatorLabel = strategyCuratorLabel(strategy);

  // Provider metadata, not a gate: backing, protocol, curating house — deduped,
  // because "Maple · Curated by Maple" says one thing twice.
  const meta = [
    t(`DashboardEarn.source.${strategy.sourceKind}`),
    sourceLabel,
    curatorLabel && curatorLabel !== sourceLabel
      ? t("DashboardEarn.deposit.curatedBy", { curator: curatorLabel })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // The decision facts in one quiet line; an unreported pool is simply absent
  // rather than a "not reported" placeholder shouting on every sandbox row.
  const facts = [
    liquidityLabel(strategy),
    poolUsd === undefined
      ? null
      : t("DashboardEarn.deposit.poolMeta", { value: formatUsdCompact(poolUsd) }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SelectableCard
      describedBy={detailId}
      inputId={inputId}
      labelledBy={nameId}
      name="earn-strategy"
      onSelect={onSelect}
      selected={selected}
      value={strategy.id}
    >
      <span className="flex items-center gap-5">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-base font-medium tracking-tight text-primary" id={nameId}>
              {strategy.name}
            </span>
            {/* Only when the catalogue holds more than one stablecoin — a chip
                repeated on every row is texture, not information. */}
            {showTokenChip && token ? (
              <span className="rounded-md bg-fill px-2 py-0.5 text-[11px] font-medium text-secondary">
                {token.toUpperCase()}
              </span>
            ) : null}
          </span>
          <span className="mt-1 block truncate text-[13px] leading-5 text-secondary" id={detailId}>
            {meta}
          </span>
          <span className="mt-0.5 block text-[13px] leading-5 text-tertiary">{facts}</span>
        </span>

        <span className="shrink-0 text-right">
          <span className="block text-2xl font-medium tracking-tight text-primary tabular-nums">
            {formatApy(strategy.currentApy)}
          </span>
          <span className="mt-0.5 block text-xs text-tertiary">
            {t(`DashboardEarn.apyType.${strategy.apyType}`)}
          </span>
        </span>
        <SelectionMark selected={selected} />
      </span>
    </SelectableCard>
  );
}

export function StrategyStep({
  filters,
  hasError,
  isLoading,
  onFiltersChange,
  onReset,
  onSelect,
  selectedStrategyId,
  strategies,
  tokens,
}: {
  filters: EarnStrategyFilters;
  hasError: boolean;
  isLoading: boolean;
  onFiltersChange: (next: EarnStrategyFilters) => void;
  onReset: () => void;
  onSelect: (strategyId: string) => void;
  selectedStrategyId: string | null;
  strategies: readonly EarnStrategy[];
  tokens: readonly EarnPortfolioToken[];
}) {
  const t = useTranslations();
  const selected = strategies.find((strategy) => strategy.id === selectedStrategyId);
  // A lone stablecoin needs no per-row chip; the review step still names it.
  const showTokenChip = tokens.length > 1;

  return (
    <div className="space-y-4">
      <FilterBar
        filters={filters}
        onChange={onFiltersChange}
        onReset={onReset}
        resultCount={strategies.length}
        tokens={tokens}
      />

      {isLoading ? <StepListSkeleton rowClassName="h-32 w-full rounded-2xl" /> : null}

      {hasError ? <StepNotice>{t("DashboardEarn.deposit.strategiesLoadError")}</StepNotice> : null}

      {!isLoading && !hasError && strategies.length === 0 ? (
        <StepNotice>{t("DashboardEarn.deposit.strategiesEmpty")}</StepNotice>
      ) : null}

      {strategies.length > 0 ? (
        <fieldset className="space-y-3">
          <legend className="sr-only">{t("DashboardEarn.deposit.strategyLegend")}</legend>
          {strategies.map((strategy) => (
            <StrategyCard
              key={strategy.id}
              onSelect={() => onSelect(strategy.id)}
              selected={strategy.id === selectedStrategyId}
              showTokenChip={showTokenChip}
              strategy={strategy}
            />
          ))}
        </fieldset>
      ) : null}

      <p className="text-xs leading-5 text-muted">{t("DashboardEarn.deposit.rateDisclosure")}</p>

      <SelectionAnnouncement>
        {selected
          ? t("DashboardEarn.deposit.selectedStrategyAnnouncement", { strategy: selected.name })
          : ""}
      </SelectionAnnouncement>
    </div>
  );
}
