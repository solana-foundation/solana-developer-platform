"use client";

import type { EarnStrategy } from "@sdp/types";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "@/i18n/provider";
import {
  DEFAULT_STRATEGY_SORT,
  type EarnStrategySort,
  type EarnStrategySortColumn,
  nextStrategySort,
  opportunityDepositability,
  sortStrategies,
} from "./deposit/earn-deposit-model";
import { formatApy, formatUsdCompact } from "./earn-format";
import { strategyPoolUsd, strategyToken, useLiquidityLabel } from "./earn-program-presentation";

const DEPOSIT_PATH = "/dashboard/markets/earn/deposit";

/**
 * A numeric column the reader can rank the table by.
 *
 * `aria-sort` sits on the `th` and the click target is a real button inside it —
 * the ARIA sortable-table pattern — so the current ranking is announced with the
 * column itself rather than through a separate live region.
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
  const Icon = !active
    ? ChevronsUpDownIcon
    : sort.direction === "asc"
      ? ArrowUpIcon
      : ArrowDownIcon;

  return (
    <TableHead
      align="right"
      aria-sort={!active ? "none" : sort.direction === "asc" ? "ascending" : "descending"}
      className={className}
    >
      <button
        className="inline-flex w-full items-center justify-end gap-1 rounded-sm text-right focus-visible:ring-2 focus-visible:ring-primary/40"
        onClick={() => onSort(column)}
        type="button"
      >
        {label}
        <Icon aria-hidden="true" className="size-3.5 text-tertiary" />
      </button>
    </TableHead>
  );
}

/**
 * One catalogue row, with the verb that starts a deposit into it.
 *
 * The action is a LINK, not a button: the deposit run is addressed by
 * `?strategy=<id>`, so a row is shareable, middle-clickable, and the wizard can
 * be entered directly without this table having to hand state across a route.
 */
function OpportunityRow({ strategy }: { strategy: EarnStrategy }) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  const nameId = `earn-opportunity-${strategy.id}-name`;
  const token = strategyToken(strategy);
  const poolUsd = strategyPoolUsd(strategy);
  const depositable = opportunityDepositability(strategy);

  const blockedLabel =
    depositable.kind === "wrong-cluster"
      ? t("DashboardEarn.deposit.strategyEnvironmentOnly", {
          environment: strategy.hostCluster === "mainnet-beta" ? "Mainnet" : "Devnet",
        })
      : depositable.kind === "asset-unsupported"
        ? t("DashboardEarn.deposit.strategyAssetUnavailableLabel")
        : depositable.kind === "no-sdp-route"
          ? // Both say "not yet", never "go do it elsewhere". Depositing into a
            // vault-direct vault THROUGH SDP is intended and simply unbuilt, so
            // this copy must not send a reader off-platform — that would be
            // product direction a disabled-button label has no business
            // implying. The two strings differ only because a custodial
            // provider we are not offering is a different "not yet" from a
            // capability we have not shipped.
            t(
              depositable.style === "vault_direct"
                ? "DashboardEarn.opportunities.depositDirectOnly"
                : "DashboardEarn.opportunities.depositProviderClosed"
            )
          : null;

  return (
    <TableRow>
      {/*
        Both lines declare their OWN wrapping and their own clip, and the cell
        declares neither: `TableCell` joins its base classes with the design
        system's `cn`, a plain string join with no tailwind-merge, so a
        `whitespace-normal` passed to the cell loses to its own `nowrap` base.
        Provider names run long ("Janus Henderson JTRSY tokenized by Centrifuge").
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
        {/* No provenance line. `underlyingSource` is the protocol a vault runs
            on ("klend") — plumbing, not a reason to pick one yield source over
            another, and it rendered as a bare unexplained token under every
            name. Where the yield comes from is the provider's problem; what the
            reader compares is Backing, Access, Pool size and APY. Curator would
            be worth showing, but Kamino publishes none on purpose (permissionless
            registry — see packages/sdp-earn/CLAUDE.md), so the line was only ever
            "klend" or an em dash. */}
        {blockedLabel ? (
          <Badge
            className="mt-2"
            variant={depositable.kind === "wrong-cluster" ? "warning" : "default"}
          >
            {blockedLabel}
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="text-sm font-normal text-secondary">
        {token?.toUpperCase() ?? "—"}
      </TableCell>
      <TableCell className="text-sm font-normal text-secondary">
        {t(`DashboardEarn.source.${strategy.sourceKind}`)}
      </TableCell>
      <TableCell className="text-sm font-normal text-secondary">
        {liquidityLabel(strategy)}
      </TableCell>
      <TableCell align="right" className="text-sm font-normal text-secondary" numeric>
        {poolUsd === undefined ? "—" : formatUsdCompact(poolUsd)}
      </TableCell>
      <TableCell align="right" className="text-sm font-normal" numeric>
        <span className="block text-primary">{formatApy(strategy.currentApy)}</span>
        <span className="mt-1 block text-secondary">
          {t(`DashboardEarn.apyType.${strategy.apyType}`)}
        </span>
      </TableCell>
      <TableCell align="right">
        {depositable.kind === "depositable" ? (
          <Button asChild size="sm" variant="secondary">
            <Link href={`${DEPOSIT_PATH}?strategy=${encodeURIComponent(strategy.id)}`}>
              {t("DashboardEarn.opportunities.deposit")}
            </Link>
          </Button>
        ) : (
          // Disabled rather than absent: the row still explains itself through
          // the badge beside its name, and a missing verb reads as an oversight.
          // `title` carries the reason to a pointer, since the badge sits in a
          // different column.
          <Button disabled size="sm" title={blockedLabel ?? undefined} variant="secondary">
            {t("DashboardEarn.opportunities.deposit")}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * The Opportunities tab: every strategy SDP currently lists, ranked, each with
 * the verb that deposits into it.
 *
 * The catalogue arrives already filtered by the API — un-surfaced providers and
 * hidden sources never reach the browser — so this renders what it is handed and
 * never re-applies a visibility rule. What it DOES decide is per-row
 * depositability, which is a different question (`opportunityDepositability`).
 */
export function EarnOpportunitiesTable({ strategies }: { strategies: readonly EarnStrategy[] }) {
  const t = useTranslations();
  const [sort, setSort] = useState<EarnStrategySort>(DEFAULT_STRATEGY_SORT);
  const rows = useMemo(() => sortStrategies(strategies, sort), [strategies, sort]);
  const onSort = (column: EarnStrategySortColumn) =>
    setSort((current) => nextStrategySort(current, column));

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-border-subtle bg-fill-subtle p-3 text-sm leading-6 text-secondary">
        {t("DashboardEarn.overview.catalogueEmpty")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table className="table-fixed" style={{ minWidth: "56rem" }}>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%]">{t("DashboardEarn.deposit.strategyColumn")}</TableHead>
            <TableHead className="w-[9%]">
              {t("DashboardEarn.deposit.strategyStablecoinColumn")}
            </TableHead>
            <TableHead className="w-[12%]">
              {t("DashboardEarn.deposit.strategyBackingColumn")}
            </TableHead>
            <TableHead className="w-[13%]">
              {t("DashboardEarn.deposit.strategyAccessColumn")}
            </TableHead>
            <SortableColumnHeader
              className="w-[12%]"
              column="pool"
              label={t("DashboardEarn.deposit.strategyPoolColumn")}
              onSort={onSort}
              sort={sort}
            />
            <SortableColumnHeader
              className="w-[12%]"
              column="apy"
              label={t("DashboardEarn.deposit.strategyApyColumn")}
              onSort={onSort}
              sort={sort}
            />
            <TableHead align="right" className="w-[12%]">
              <span className="sr-only">{t("DashboardEarn.opportunities.columnAction")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((strategy) => (
            <OpportunityRow key={strategy.id} strategy={strategy} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
