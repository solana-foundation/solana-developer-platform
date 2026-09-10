"use client";

/**
 * The trades list.
 *
 * The filters live in the URL (`?status=<group>&q=<text>`, the transactions
 * pattern): the group and the debounced search text are pushed with
 * `router.replace` inside a transition, and the server refetches with them —
 * the list is capped with no cursor, so a client-side search would make an
 * older matching trade unfindable.
 *
 * `waiting` stays component state: it swaps in a different endpoint's rows
 * (the inbound list), which the URL has no reason to carry, and its search
 * stays client-side because that list is small and complete.
 */

import {
  ArrowDownLeftIcon,
  ArrowLeftRightIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  DashboardWorkspaceCard,
  DashboardWorkspaceOverviewPanel,
} from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { type UrlTableQueryAdapter, useUrlTableFilters } from "@/lib/use-url-table-filters";
import { cn } from "@/lib/utils";
import { formatTimestamp, shortenAddress } from "../../payments/payments-overview.utils";
import { InboundRows } from "./dvp-inbound-rows";
import { DvpPartyCell } from "./dvp-party-cell";
import { DvpStatusBadge } from "./dvp-status";
import {
  type DvpTrade,
  type DvpTradeLeg,
  formatLegAmount,
  frozenLegs,
  isDvpTradeClosed,
  matchesAddressQuery,
  overFundedLegs,
} from "./dvp-trade";
import { DVP_TRADES_PAGE_SIZE, type DvpInboundTrade } from "./dvp-trades.data";
import { type StatusFilter, serializeDvpTradesFilters } from "./dvp-trades-query";

/** Their labels, in the order the dropdown shows them — which is the order a
 * trade moves through, so the control reads as a lifecycle rather than as an
 * arbitrary set. `satisfies` keeps it exhaustive: a fifth filter is a compile
 * error here rather than a missing option at runtime. */
const STATUS_FILTER_LABELS = {
  all: "DashboardMarkets.dvp.filterAll",
  waiting: "DashboardMarkets.dvp.filterWaiting",
  open: "DashboardMarkets.dvp.filterOpen",
  ready: "DashboardMarkets.dvp.filterReady",
  closed: "DashboardMarkets.dvp.filterClosed",
} as const satisfies Record<StatusFilter, MessageKey>;

const STATUS_FILTER_ORDER = Object.keys(STATUS_FILTER_LABELS) as StatusFilter[];

/** The trades status groups that ride the URL. */
type UrlStatusFilter = Exclude<StatusFilter, "waiting">;

interface DvpTradesUrlState {
  status: UrlStatusFilter;
  query: string;
}

/**
 * Whether a trade answers the search box.
 *
 * What somebody has to hand when hunting for one trade: the counterparty they
 * agreed it with, a symbol, or an address off an explorer. Both parties always,
 * because on an agent trade neither of them is us and either is what somebody
 * would paste in.
 *
 * Kept for the WAITING list only: that list is small and complete, so the
 * client answers without a round trip. The project's own list is filtered
 * server-side, where the whole history is searchable.
 *
 * @param trade - The inbound trade under the sieve.
 * @param needle - The query, already trimmed and lowercased ("" matches all).
 */
function matchesTradeQuery(trade: DvpInboundTrade, needle: string): boolean {
  if (!needle) {
    return true;
  }
  return [
    trade.id,
    trade.swapDvp,
    trade.legs.a.symbol,
    trade.legs.b.symbol,
    trade.legs.a.mint,
    trade.legs.b.mint,
    trade.legs.a.party.address,
    trade.legs.b.party.address,
  ]
    .filter(Boolean)
    .some((value) => matchesAddressQuery(String(value), needle));
}

/** Rows per client-side page of the trades table. */
const TRADES_PER_PAGE = 10;

/** The page path, with the filters serialized onto it. */
function tradesHref(state: DvpTradesUrlState): string {
  const query = serializeDvpTradesFilters(state.status, state.query === "" ? null : state.query);
  return `${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}${query}`;
}

const DVP_TRADES_QUERY_ADAPTER: UrlTableQueryAdapter<DvpTradesUrlState> = {
  read: (state) => state.query,
  write: (state, query) => ({ ...state, query }),
  minLength: 2,
  maxLength: 100,
};

/**
 * A leg as one cell: what it is worth, and whether the escrow has it.
 *
 * The observed amount is shown next to the target rather than instead of it,
 * because "1000 of 1000" and "1000" answer different questions and only the
 * first says whether anything is still owed.
 */
function LegCell({
  closed,
  leg,
  mine,
}: {
  closed: boolean;
  leg: DvpTradeLeg;
  /** Whether the caller holds custody of this leg's party address. */
  mine: boolean;
}) {
  const t = useTranslations();
  const direction = mine
    ? { Icon: ArrowUpRightIcon, key: closed ? "youDelivered" : "youDeliver" }
    : { Icon: ArrowDownLeftIcon, key: closed ? "youReceived" : "youReceive" };

  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* Which way this leg moves. The columns are fixed — Asset leg, Cash leg
          — which names the legs and never says who gave what, so a row where
          you delivered the cash was indistinguishable from one where you
          delivered the asset. Two rows of the same trade type read identically
          while meaning opposite things. The arrows differ down the column, so
          the direction is scannable rather than something you open a trade to
          find out. Same words the detail page uses. */}
      <direction.Icon
        aria-hidden
        className={cn("h-3.5 w-3.5 shrink-0", mine ? "text-tertiary" : "text-success")}
      />
      <span className="sr-only">{t(`DashboardMarkets.dvp.${direction.key}` as MessageKey)}</span>
      {/* The mark resolves a logo only for a mint in the well-known registry,
          and falls back to a monogram of the SYMBOL — which it can only do if
          it is given one. Passing the mint alone left every issued asset
          rendering a literal question mark. */}
      <TokenMark className="shrink-0" mint={leg.mint} size="sm" symbol={leg.symbol} />
      <div className="min-w-0">
        {/* Observed-over-target answers "is anything still owed", which is a
            question a finished trade does not have. Its escrows are closed and
            empty, so the stored reading is a leftover from before settlement —
            and showing it as a fraction claimed a balance that no longer
            exists. Worse, a trade settled before that reading was ever taken
            showed a bare number, so two finished trades rendered differently.
            A finished trade shows what it delivered. */}
        <div className="truncate font-medium text-primary text-sm tabular-nums">
          {leg.funding && !closed
            ? `${formatLegAmount(leg.funding.observedAmount, leg.decimals)} / ${formatLegAmount(leg.amount, leg.decimals)}`
            : formatLegAmount(leg.amount, leg.decimals)}
          {leg.symbol ? <span className="ml-1 text-secondary">{leg.symbol}</span> : null}
        </div>
        {/* The mint only when it has no symbol to stand in for it — a row
            showing both reads as a name followed by a second, longer name. */}
        {leg.symbol ? null : (
          <div className="truncate text-tertiary text-xs">{shortenAddress(leg.mint)}</div>
        )}
      </div>
    </div>
  );
}

/**
 * One row of the project's own trades.
 *
 * The whole row navigates, via a stretched link on the status cell. Actions
 * live on the detail page.
 */
function OwnTradeRow({ trade }: { trade: DvpTrade }) {
  const t = useTranslations();
  // Both parties, each styled for how the API classifies it: a counterparty
  // link when registered, a wallet link when the caller custodies the
  // address, plain otherwise.
  const parties = [trade.legs.a.party, trade.legs.b.party];
  // Marked on the row rather than announced in a banner: a warning that does not
  // say WHICH trade sends an operator through every row to find it.
  //
  // The two conditions need different words. Labelling a frozen escrow "holds
  // more than the trade needs" is not a vague warning, it is a false one, and it
  // is the only thing a screen reader gets from this icon.
  const attention = frozenLegs(trade).length
    ? t("DashboardMarkets.dvp.frozenTitle")
    : overFundedLegs(trade).length
      ? t("DashboardMarkets.dvp.surplusTitle")
      : null;
  const closed = isDvpTradeClosed(trade);

  return (
    <TableRow className="relative hover:bg-fill-subtle">
      <TableCell>
        <Link
          className="inline-flex items-center gap-1.5 after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
          href={`${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/${trade.id}`}
        >
          <DvpStatusBadge status={trade.status} />
          {attention ? (
            <TriangleAlertIcon
              aria-label={attention}
              className="h-3.5 w-3.5 shrink-0 text-warning"
            />
          ) : null}
        </Link>
      </TableCell>
      <TableCell>
        <LegCell closed={closed} leg={trade.legs.a} mine={trade.legs.a.party.wallet !== null} />
      </TableCell>
      <TableCell>
        <LegCell closed={closed} leg={trade.legs.b} mine={trade.legs.b.party.wallet !== null} />
      </TableCell>
      <TableCell className="text-secondary text-sm">
        {/* Shortened to read, copyable in full. A truncated address is not an
            address: it cannot be pasted into a wallet, an explorer or a message
            back to the other side, which is most of what anyone wants this
            column for. */}
        <span className="grid gap-0.5">
          {parties.map((party) => (
            <DvpPartyCell key={party.address} party={party} />
          ))}
        </span>
      </TableCell>
      <TableCell className="text-secondary text-sm">
        {formatTimestamp(trade.createdAt, t)}
      </TableCell>
      <TableCell>
        <ChevronRightIcon aria-hidden className="h-4 w-4 text-tertiary" />
      </TableCell>
    </TableRow>
  );
}

/**
 * The control strip: search, the status dropdown, and the create action.
 *
 * Extracted so the workspace reads as a sequence of sections rather than as one
 * function holding the filter markup, its counts and its empty-option rule.
 */
function TradesToolbar({
  inboundCount,
  onQueryChange,
  onStatusChange,
  query,
  status,
  tradeCount,
}: {
  inboundCount: number;
  onQueryChange: (next: string) => void;
  onStatusChange: (next: StatusFilter) => void;
  query: string;
  status: StatusFilter;
  tradeCount: number;
}) {
  const t = useTranslations();
  // Only once there is enough to sift. A filter bar over three rows is
  // furniture — but an inbound trade is reachable ONLY through its option, so
  // hiding the control hides the trade with it. The create button stays either
  // way; it is the strip's one permanent occupant.
  const showFilters = tradeCount > 1 || inboundCount > 0;
  // The waiting option only exists when it has something in it; an empty one
  // would be a permanent dead control. The count rides on the label, because a
  // trade waiting on this project is the one thing here with a deadline against
  // it and a number says so without a banner that is empty most days.
  // One pass: dropping the empty option and labelling the rest are the same
  // decision per option, and splitting them into filter-then-map walks the list
  // twice to answer it.
  const items = STATUS_FILTER_ORDER.flatMap((option) => {
    if (option === "waiting" && inboundCount === 0) {
      return [];
    }
    return [
      {
        value: option,
        label:
          option === "waiting"
            ? `${t(STATUS_FILTER_LABELS[option])} \u00b7 ${inboundCount}`
            : t(STATUS_FILTER_LABELS[option]),
      },
    ];
  });

  return (
    <div className="border-b border-border-default p-3">
      {showFilters ? (
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-[minmax(280px,1fr)_190px_auto]">
          <SearchInput
            aria-label={t("DashboardMarkets.dvp.filterSearchLabel")}
            clear={{
              label: t("DashboardMarkets.dvp.filterClearSearch"),
              onClear: () => onQueryChange(""),
            }}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={t("DashboardMarkets.dvp.filterSearchPlaceholder")}
            value={query}
          />
          <Select
            ariaLabel={t("DashboardMarkets.dvp.filterStatusLabel")}
            // Clearing the selection is not a state this filter has: "all" is
            // itself an option, so an empty value from the trigger is ignored.
            onValueChange={(next) => next && onStatusChange(next as StatusFilter)}
            value={status}
          >
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </Select>
          <CreateTradeButton />
        </div>
      ) : (
        <div className="flex justify-end">
          <CreateTradeButton />
        </div>
      )}
    </div>
  );
}

/**
 * The table for whichever segment is showing.
 *
 * Both segments share one header because they answer the same shape of
 * question; only two column names change, since a party acts on an expiry and
 * a funding action rather than on when we created the trade.
 */
function TradesTable({
  inbound,
  showingInbound,
  trades,
}: {
  inbound: DvpInboundTrade[];
  showingInbound: boolean;
  trades: DvpTrade[];
}) {
  const t = useTranslations();
  return (
    <Table className="rounded-none border-0">
      <TableHeader>
        <TableRow>
          <TableHead>{t("DashboardMarkets.dvp.columnStatus")}</TableHead>
          <TableHead>{t("DashboardMarkets.dvp.columnAsset")}</TableHead>
          <TableHead>{t("DashboardMarkets.dvp.columnCash")}</TableHead>
          {/* "Parties", not "Counterparty": the list mixes trades
              where we hold a leg with trades set up for two other
              parties, and the second kind has no counterparty
              because we are not one of the sides. */}
          <TableHead>
            {t(
              showingInbound
                ? "DashboardMarkets.dvp.inboundColumnFund"
                : "DashboardMarkets.dvp.columnParties"
            )}
          </TableHead>
          <TableHead>
            {t(
              showingInbound
                ? "DashboardMarkets.dvp.inboundColumnExpires"
                : "DashboardMarkets.dvp.columnCreated"
            )}
          </TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {showingInbound ? <InboundRows trades={inbound} /> : null}
        {trades.map((trade) => (
          <OwnTradeRow key={trade.id} trade={trade} />
        ))}
      </TableBody>
    </Table>
  );
}

/** The one call to action on this page, in both places it appears. */
function CreateTradeButton() {
  const t = useTranslations();
  return (
    <Button asChild size="sm">
      <Link href={`${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/create`}>
        <PlusIcon className="size-4" />
        {t("DashboardMarkets.dvp.createCta")}
      </Link>
    </Button>
  );
}

export function DvpTradesWorkspace({
  trades,
  inbound,
  error,
  searchQuery,
  statusFilter,
}: {
  trades: DvpTrade[];
  /** Trades another organization created that name one of this project's wallets. */
  inbound: DvpInboundTrade[];
  error: string | null;
  /** The active URL search text ("" when none), not the live input value. */
  searchQuery: string;
  /** The active URL status group for the trades list. */
  statusFilter: UrlStatusFilter;
}) {
  const t = useTranslations();
  const {
    queryInput,
    resetFilters,
    resultKey,
    setQueryInput,
    state: urlFilters,
    updateFilters,
  } = useUrlTableFilters({
    returnedState: { status: statusFilter, query: searchQuery },
    href: tradesHref,
    query: DVP_TRADES_QUERY_ADAPTER,
  });

  // Pagination belongs to the rows returned for one exact URL filter state.
  // Adopting another state through Back/Forward therefore starts at page one,
  // including when the old page number would happen to remain in range.
  const [pagination, setPagination] = useState({ resultKey, page: 1 });
  if (pagination.resultKey !== resultKey) {
    setPagination({ resultKey, page: 1 });
  }

  // The URL is the filter state for the trades list; `waiting` selects the
  // inbound segment instead and lives here only, because it answers from a
  // different endpoint the URL has no reason to name. A browser navigation
  // that changes the URL group lands back on the trades segment.
  const [waitingSelection, setWaitingSelection] = useState({ status: statusFilter, active: false });
  if (waitingSelection.status !== urlFilters.status) {
    setWaitingSelection({ status: urlFilters.status, active: false });
  }
  const waiting = waitingSelection.status === urlFilters.status ? waitingSelection.active : false;

  const onStatusChange = (next: StatusFilter) => {
    setPagination({ resultKey, page: 1 });
    if (next === "waiting") {
      // The inbound segment swaps the table's rows rather than filtering the
      // trades list, so it never reaches the URL or the trades API.
      setWaitingSelection({ status: urlFilters.status, active: true });
      return;
    }
    setWaitingSelection({ status: next, active: false });
    updateFilters({ status: next });
  };

  /** Clear filters resets the search, the page and the URL params — the whole filter state. */
  const clearFilters = () => {
    setWaitingSelection({ status: "all", active: false });
    setPagination({ resultKey, page: 1 });
    resetFilters({ status: "all", query: "" });
  };

  const showingInbound = waiting;
  // The inbound segment keeps its client-side sieve: that list is small and
  // complete, so the live input answers without a round trip.
  const needle = queryInput.trim().toLowerCase();
  const visibleInbound = showingInbound
    ? inbound.filter((trade) => matchesTradeQuery(trade, needle))
    : [];
  // Clamped during render rather than reset by an effect: shrinking the list
  // from a later page lands on the last page that still exists.
  const pageCount = Math.max(1, Math.ceil(trades.length / TRADES_PER_PAGE));
  const currentPage = pagination.resultKey === resultKey ? Math.min(pagination.page, pageCount) : 1;
  const pagedTrades = trades.slice(
    (currentPage - 1) * TRADES_PER_PAGE,
    currentPage * TRADES_PER_PAGE
  );

  // A project whose only DvP activity is a trade somebody else set up for it has
  // none of its own, and treating that as an empty page rendered "No trades yet"
  // over the one thing waiting on them, with no filter control on screen to
  // reach it by. Having nothing to do is what empty means here.
  const listIsEmpty = trades.length === 0 && inbound.length === 0;
  // Rows shown on the current segment, from either source. The waiting segment
  // draws from `inbound` and leaves the trades table empty by design, so
  // counting only `trades` declared "no trades match" over a table that had a
  // row to render.
  const shownCount = showingInbound ? visibleInbound.length : trades.length;

  const filteredToNothing = !(listIsEmpty && !showingInbound) && shownCount === 0;

  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col gap-4">
      {/* The same section heading treasury-solutions renders over its card. */}
      <h2 className="flex items-center gap-1 text-[19px] leading-6 font-medium text-primary">
        {t("DashboardMarkets.dvp.tradesTitle")}
      </h2>
      {/* An error and a table of nothing say different things, and showing
          both says the list is empty when the truth is that it could not be
          read. The error stands alone. */}
      {error ? (
        <Callout live title={t("DashboardMarkets.dvp.listErrorTitle")} variant="danger">
          {error}
        </Callout>
      ) : (
        <DashboardWorkspaceCard>
          {listIsEmpty ? (
            /* The strip is suppressed with the list, because the empty state
               already carries this exact call to action and two of the same
               button on one screen reads as two different actions. */
            <ListEmptyState
              action={<CreateTradeButton />}
              description={t("DashboardMarkets.dvp.emptyDescription")}
              icon={<ArrowLeftRightIcon className="size-5" />}
              message={t("DashboardMarkets.dvp.empty")}
            />
          ) : (
            <>
              {/* The control strip every list page opens with (transactions,
                  recurring): search then filters on the left, the create
                  action on the right, table flush below. */}
              <TradesToolbar
                inboundCount={inbound.length}
                onQueryChange={(next) => {
                  setQueryInput(next);
                  setPagination({ resultKey, page: 1 });
                }}
                onStatusChange={onStatusChange}
                query={queryInput}
                status={waiting ? "waiting" : urlFilters.status}
                tradeCount={trades.length}
              />

              {/* "Nothing matches" and "you have none" are different
                  answers, and offering "create a trade" to somebody who
                  just over-filtered sends them to make a second one they
                  do not need. */}
              {filteredToNothing ? (
                <ListEmptyState
                  action={
                    <Button onClick={clearFilters} size="sm" type="button" variant="secondary">
                      {t("DashboardMarkets.dvp.filterClear")}
                    </Button>
                  }
                  icon={<ArrowLeftRightIcon className="size-5" />}
                  message={t("DashboardMarkets.dvp.filterNoMatches")}
                />
              ) : (
                <>
                  <TradesTable
                    inbound={visibleInbound}
                    showingInbound={showingInbound}
                    trades={showingInbound ? [] : pagedTrades}
                  />
                  {!showingInbound && pageCount > 1 ? (
                    <ArrowPagination
                      className="border-border-default border-t p-3"
                      onPageChange={(page) => setPagination({ resultKey, page })}
                      page={currentPage}
                      pageCount={pageCount}
                    />
                  ) : null}
                </>
              )}
            </>
          )}
        </DashboardWorkspaceCard>
      )}

      {/* The list is capped and has no cursor upstream, so say so rather than
          letting it read as the complete set. */}
      {!showingInbound && trades.length >= DVP_TRADES_PAGE_SIZE ? (
        <p className="text-tertiary text-xs">
          {t("DashboardMarkets.dvp.moreTrades", { count: String(DVP_TRADES_PAGE_SIZE) })}
        </p>
      ) : null}
    </DashboardWorkspaceOverviewPanel>
  );
}
