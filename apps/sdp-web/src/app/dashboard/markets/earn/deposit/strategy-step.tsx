"use client";

import type { EarnPortfolioToken, EarnProviderId, EarnStrategy } from "@sdp/types";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
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
  DEFAULT_STRATEGY_SORT,
  type EarnStrategySort,
  type EarnStrategySortColumn,
  nextStrategySort,
  sortStrategies,
  strategyDepositEligibility,
} from "./earn-deposit-model";

/**
 * A numeric column the reader can rank the table by.
 *
 * `aria-sort` sits on the `th` and the click target is a real button inside it —
 * the ARIA sortable-table pattern — so the current ranking is announced with the
 * column itself rather than through a separate live region. At rest the neutral
 * chevrons say "this column is clickable"; the active column shows the direction
 * it is ranked in.
 */
function SortableColumnHeader({
  className,
  column,
  label,
  onSort,
  sort,
}: {
  className: string;
  column: EarnStrategySortColumn;
  label: string;
  onSort: (column: EarnStrategySortColumn) => void;
  sort: EarnStrategySort;
}) {
  const active = sort.column === column;
  const ascending = active && sort.direction === "asc";
  const Indicator = active ? (ascending ? ArrowUpIcon : ArrowDownIcon) : ChevronsUpDownIcon;

  return (
    <TableHead
      align="right"
      aria-sort={active ? (ascending ? "ascending" : "descending") : "none"}
      className={className}
    >
      <button
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/40"
        onClick={() => onSort(column)}
        type="button"
      >
        {label}
        <Indicator
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", active ? "text-secondary" : "text-muted")}
        />
      </button>
    </TableHead>
  );
}

function StrategyTableRow({
  onSelect,
  portfolioProvider,
  selected,
  showTokenColumn,
  strategy,
}: {
  onSelect: () => void;
  portfolioProvider: EarnProviderId | undefined;
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
  const availabilityId = `${inputId}-availability`;
  const token = strategyToken(strategy);
  const poolUsd = strategyPoolUsd(strategy);
  const sourceLabel = strategySourceLabel(strategy);
  const curatorLabel = strategyCuratorLabel(strategy);
  const eligibility = strategyDepositEligibility(strategy, portfolioProvider);
  const selectable = eligibility === "eligible";
  const hostNetwork = strategy.hostCluster === "mainnet-beta" ? "Mainnet" : "Devnet";
  const unavailable =
    eligibility === "environment-mismatch"
      ? {
          label: t("DashboardEarn.deposit.strategyEnvironmentOnly", { environment: hostNetwork }),
          description: t("DashboardEarn.deposit.strategyEnvironmentUnavailable", {
            environment: hostNetwork,
          }),
        }
      : eligibility === "provider-unsupported"
        ? {
            label: t("DashboardEarn.deposit.strategyBrowseOnly"),
            description: t("DashboardEarn.deposit.strategyProviderUnavailable"),
          }
        : eligibility === "asset-unsupported"
          ? {
              label: t("DashboardEarn.deposit.strategyAssetUnavailableLabel"),
              description: t("DashboardEarn.deposit.strategyAssetUnavailable"),
            }
          : null;

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
      aria-disabled={selectable ? undefined : true}
      aria-selected={selected}
      className={selectable ? "cursor-pointer" : "cursor-default"}
      data-state={selected ? "selected" : undefined}
      onClick={(event) => {
        if (!selectable) return;
        const target = event.target as HTMLElement;
        if (target.closest("input, label")) return;
        onSelect();
      }}
    >
      <TableCell className="relative w-12">
        <input
          aria-describedby={`${backingId} ${accessId} ${poolId} ${apyId}${unavailable ? ` ${availabilityId}` : ""}`}
          aria-labelledby={nameId}
          checked={selected}
          className="peer sr-only"
          disabled={!selectable}
          id={inputId}
          name="earn-strategy"
          onChange={onSelect}
          type="radio"
          value={strategy.id}
        />
        <label
          className={cn(
            "inline-flex rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40",
            selectable ? "cursor-pointer" : "cursor-not-allowed opacity-40"
          )}
          htmlFor={inputId}
        >
          <SelectionMark selected={selected} />
          <span className="sr-only">{t("DashboardEarn.deposit.selectStrategy")}</span>
        </label>
      </TableCell>
      {/*
        Both lines declare their OWN wrapping and their own clip, and the cell
        declares neither.

        `TableCell` joins its base classes with the design system's `cn`, which is
        a plain string join with no tailwind-merge — and `.whitespace-nowrap` is
        emitted after `.whitespace-normal`, so the `whitespace-normal` this cell
        used to pass in never applied. Provider names run long ("Janus Henderson
        JTRSY tokenized by Centrifuge"), and under `table-fixed` a nowrap name
        overflowed its column and collided with Backing. Declaring it on the
        spans works because an element's own value beats an inherited one.
      */}
      <TableCell className="text-sm font-normal">
        {/* No `block`: line-clamp-2 sets `display:-webkit-box`, and with no
            tailwind-merge here the two display utilities would fight. */}
        <span
          className="line-clamp-2 break-words whitespace-normal text-primary"
          id={nameId}
          title={strategy.name}
        >
          {strategy.name}
        </span>
        {/* Secondary metadata: one line, ellipsis past it — the name is what
            must stay legible. */}
        <span className="mt-1 block truncate text-secondary" title={sourceMeta || undefined}>
          {sourceMeta || "—"}
        </span>
        {unavailable ? (
          <>
            <Badge
              aria-hidden="true"
              className="mt-2"
              title={unavailable.description}
              variant={eligibility === "environment-mismatch" ? "warning" : "default"}
            >
              {unavailable.label}
            </Badge>
            <span className="sr-only" id={availabilityId}>
              {unavailable.description}
            </span>
          </>
        ) : null}
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
  hasError,
  isLoading,
  onSelect,
  portfolioProvider,
  selectedStrategyId,
  strategies,
  tokens,
}: {
  hasError: boolean;
  isLoading: boolean;
  onSelect: (strategyId: string) => void;
  portfolioProvider: EarnProviderId | undefined;
  selectedStrategyId: string | null;
  strategies: readonly EarnStrategy[];
  tokens: readonly EarnPortfolioToken[];
}) {
  const t = useTranslations();
  const selected = strategies.find(
    (strategy) =>
      strategy.id === selectedStrategyId &&
      strategyDepositEligibility(strategy, portfolioProvider) === "eligible"
  );
  // A lone stablecoin needs no repeated table column; review still names it.
  const showTokenColumn = tokens.length > 1;

  /**
   * How the reader ranked the table. View state, held here rather than in the
   * wizard: re-entering this step restores the default order, the same way it
   * lands pre-scrolled at the top. The selected strategy survives either way —
   * it is the wizard's, and it stays checked wherever the row moves to.
   *
   * Rows arrive already in {@link DEFAULT_STRATEGY_SORT} order, so this is a
   * no-op until the reader clicks a column (one comparator, see the model).
   */
  const [sort, setSort] = useState<EarnStrategySort>(DEFAULT_STRATEGY_SORT);
  const rows = useMemo(() => sortStrategies(strategies, sort), [sort, strategies]);
  const hasUnavailableStrategies = strategies.some(
    (strategy) => strategyDepositEligibility(strategy, portfolioProvider) !== "eligible"
  );
  const sortBy = (column: EarnStrategySortColumn) =>
    setSort((current) => nextStrategySort(current, column));

  return (
    <div className="space-y-4">
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
              {/* Widths follow the content. The name column carries fund names
                  several words long ("Bitwise Crypto Carry Fund tokenized by
                  Superstate") plus a curator line, while Backing and Access only
                  ever hold "DeFi"/"RWA" and "Instant"/"T+n". Measured at the
                  wizard's 830px: 41% is what lets the longest row in today's
                  catalogue render both of its lines in full. */}
              <TableHead className={showTokenColumn ? "w-[33%]" : "w-[41%]"}>
                {t("DashboardEarn.deposit.strategyColumn")}
              </TableHead>
              {showTokenColumn ? (
                <TableHead className="w-[12%]">
                  {t("DashboardEarn.deposit.strategyStablecoinColumn")}
                </TableHead>
              ) : null}
              <TableHead className="w-[12%]">
                {t("DashboardEarn.deposit.strategyBackingColumn")}
              </TableHead>
              <TableHead className="w-[12%]">
                {t("DashboardEarn.deposit.strategyAccessColumn")}
              </TableHead>
              <SortableColumnHeader
                className={showTokenColumn ? "w-[14%]" : "w-[15%]"}
                column="pool"
                label={t("DashboardEarn.deposit.strategyPoolColumn")}
                onSort={sortBy}
                sort={sort}
              />
              <SortableColumnHeader
                className={showTokenColumn ? "w-[14%]" : "w-[15%]"}
                column="apy"
                label={t("DashboardEarn.deposit.strategyApyColumn")}
                onSort={sortBy}
                sort={sort}
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((strategy) => (
              <StrategyTableRow
                key={strategy.id}
                onSelect={() => onSelect(strategy.id)}
                portfolioProvider={portfolioProvider}
                selected={strategy.id === selected?.id}
                showTokenColumn={showTokenColumn}
                strategy={strategy}
              />
            ))}
          </TableBody>
        </Table>
      ) : null}

      {hasUnavailableStrategies ? (
        <p className="text-xs leading-5 text-secondary">
          {t("DashboardEarn.deposit.strategyAvailabilityDisclosure")}
        </p>
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
