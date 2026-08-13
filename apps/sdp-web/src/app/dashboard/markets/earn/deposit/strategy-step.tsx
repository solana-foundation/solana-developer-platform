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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  // A future programmatic value that has no control yet renders honestly as
  // "any" rather than snapping to a different visible constraint.
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
      <div
        className={
          tokens.length > 1
            ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            : "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        }
      >
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

function StrategyTableRow({
  onSelect,
  selected,
  showTokenColumn,
  strategy,
}: {
  onSelect: () => void;
  selected: boolean;
  showTokenColumn: boolean;
  strategy: EarnStrategy;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  const inputId = `earn-strategy-${strategy.id}`;
  const nameId = `${inputId}-name`;
  const backingId = `${inputId}-backing`;
  const accessId = `${inputId}-access`;
  const poolId = `${inputId}-pool`;
  const apyId = `${inputId}-apy`;
  const token = strategyToken(strategy);
  const poolUsd = strategyPoolUsd(strategy);
  const sourceLabel = strategySourceLabel(strategy);
  const curatorLabel = strategyCuratorLabel(strategy);

  // Provider metadata, not a gate: protocol and curating house are deduped,
  // because "Maple · Curated by Maple" says one thing twice.
  const sourceMeta = [
    sourceLabel,
    curatorLabel && curatorLabel !== sourceLabel
      ? t("DashboardEarn.deposit.curatedBy", { curator: curatorLabel })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <TableRow
      aria-selected={selected}
      className="cursor-pointer"
      data-state={selected ? "selected" : undefined}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("input, label")) return;
        onSelect();
      }}
    >
      <TableCell className="relative w-12">
        <input
          aria-describedby={`${backingId} ${accessId} ${poolId} ${apyId}`}
          aria-labelledby={nameId}
          checked={selected}
          className="peer sr-only"
          id={inputId}
          name="earn-strategy"
          onChange={onSelect}
          type="radio"
          value={strategy.id}
        />
        <label
          className="inline-flex cursor-pointer rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40"
          htmlFor={inputId}
        >
          <SelectionMark selected={selected} />
          <span className="sr-only">{t("DashboardEarn.deposit.selectStrategy")}</span>
        </label>
      </TableCell>
      <TableCell className="whitespace-normal text-sm font-normal">
        <span className="block text-primary" id={nameId}>
          {strategy.name}
        </span>
        <span className="mt-1 block text-secondary">{sourceMeta || "—"}</span>
      </TableCell>
      {showTokenColumn ? (
        <TableCell className="text-sm font-normal text-secondary">
          {token?.toUpperCase() ?? "—"}
        </TableCell>
      ) : null}
      <TableCell className="text-sm font-normal text-secondary" id={backingId}>
        {t(`DashboardEarn.source.${strategy.sourceKind}`)}
      </TableCell>
      <TableCell className="text-sm font-normal text-secondary" id={accessId}>
        {liquidityLabel(strategy)}
      </TableCell>
      <TableCell align="right" className="text-sm font-normal text-secondary" id={poolId} numeric>
        {poolUsd === undefined ? "—" : formatUsdCompact(poolUsd)}
      </TableCell>
      <TableCell align="right" className="text-sm font-normal" id={apyId} numeric>
        <span className="block text-primary">{formatApy(strategy.currentApy)}</span>
        <span className="mt-1 block text-secondary">
          {t(`DashboardEarn.apyType.${strategy.apyType}`)}
        </span>
      </TableCell>
    </TableRow>
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
  // A lone stablecoin needs no repeated table column; review still names it.
  const showTokenColumn = tokens.length > 1;

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

      {!isLoading && !hasError && strategies.length > 0 ? (
        <Table
          aria-label={t("DashboardEarn.deposit.strategyLegend")}
          className={
            showTokenColumn
              ? "[&_table]:min-w-[820px] [&_table]:table-fixed"
              : "[&_table]:min-w-[720px] [&_table]:table-fixed"
          }
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <span className="sr-only">{t("DashboardEarn.deposit.strategySelectColumn")}</span>
              </TableHead>
              <TableHead className={showTokenColumn ? "w-[25%]" : "w-[31%]"}>
                {t("DashboardEarn.deposit.strategyColumn")}
              </TableHead>
              {showTokenColumn ? (
                <TableHead className="w-[12%]">
                  {t("DashboardEarn.deposit.strategyStablecoinColumn")}
                </TableHead>
              ) : null}
              <TableHead className={showTokenColumn ? "w-[14%]" : "w-[15%]"}>
                {t("DashboardEarn.deposit.strategyBackingColumn")}
              </TableHead>
              <TableHead className={showTokenColumn ? "w-[17%]" : "w-[19%]"}>
                {t("DashboardEarn.deposit.strategyAccessColumn")}
              </TableHead>
              <TableHead align="right" className={showTokenColumn ? "w-[14%]" : "w-[15%]"}>
                {t("DashboardEarn.deposit.strategyPoolColumn")}
              </TableHead>
              <TableHead align="right" className={showTokenColumn ? "w-[14%]" : "w-[15%]"}>
                {t("DashboardEarn.deposit.strategyApyColumn")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {strategies.map((strategy) => (
              <StrategyTableRow
                key={strategy.id}
                onSelect={() => onSelect(strategy.id)}
                selected={strategy.id === selectedStrategyId}
                showTokenColumn={showTokenColumn}
                strategy={strategy}
              />
            ))}
          </TableBody>
        </Table>
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
