"use client";

import type { EarnPortfolioToken, EarnStrategy } from "@sdp/types";
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
  hasError,
  isLoading,
  onSelect,
  selectedStrategyId,
  strategies,
  tokens,
}: {
  hasError: boolean;
  isLoading: boolean;
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
