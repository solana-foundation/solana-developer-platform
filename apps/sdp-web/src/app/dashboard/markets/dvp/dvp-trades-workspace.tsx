"use client";

import { SegmentedControl } from "@solana/design-system/segmented-control";
import { ArrowLeftRightIcon, ChevronRightIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { SearchInput } from "@/components/ui/search-input";
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
import { formatTimestamp, shortenAddress } from "../../payments/payments-overview.utils";
import { DvpStatusBadge } from "./dvp-status";
import {
  type DvpTrade,
  type DvpTradeLeg,
  type DvpTradeStatus,
  formatLegAmount,
  frozenLegs,
  isDvpTradeClosed,
  matchesAddressQuery,
  overFundedLegs,
} from "./dvp-trade";
import { DVP_TRADES_PAGE_SIZE } from "./dvp-trades.data";

/**
 * A leg as one cell: what it is worth, and whether the escrow has it.
 *
 * The observed amount is shown next to the target rather than instead of it,
 * because "1000 of 1000" and "1000" answer different questions and only the
 * first says whether anything is still owed.
 */
function LegCell({ closed, leg }: { closed: boolean; leg: DvpTradeLeg }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
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
 * The statuses worth filtering to, grouped the way somebody actually looks.
 *
 * Not one entry per status: `creating`, `create_failed` and the three closed
 * states are things you look for as a group ("what is finished?"), not
 * individually, and a nine-item dropdown for a list this size is a worse
 * answer than four.
 */
const STATUS_FILTERS = {
  all: null,
  open: ["created", "partially_funded", "creating"],
  ready: ["funded"],
  closed: ["settled", "cancelled", "rejected", "closed_unknown", "create_failed", "expired"],
} as const satisfies Record<string, readonly DvpTradeStatus[] | null>;

type StatusFilter = keyof typeof STATUS_FILTERS;

/**
 * Their labels, in the order the segmented control shows them — which is the
 * order a trade moves through, so the control reads as a lifecycle rather than
 * as an arbitrary set. `satisfies` keeps it exhaustive: a fifth filter is a
 * compile error here rather than a missing segment at runtime.
 */
const STATUS_FILTER_LABELS = {
  all: "DashboardMarkets.dvp.filterAll",
  open: "DashboardMarkets.dvp.filterOpen",
  ready: "DashboardMarkets.dvp.filterReady",
  closed: "DashboardMarkets.dvp.filterClosed",
} as const satisfies Record<StatusFilter, MessageKey>;

const STATUS_FILTER_ORDER = Object.keys(STATUS_FILTER_LABELS) as StatusFilter[];

export function DvpTradesWorkspace({
  trades,
  error,
}: {
  trades: DvpTrade[];
  error: string | null;
}) {
  const t = useTranslations();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  // Filtered here rather than in the URL: the list arrives already capped by
  // `listByProject`, so everything being filtered is on the page — a round trip
  // per keystroke would be slower and no more correct.
  const needle = query.trim().toLowerCase();
  const visible = trades.filter((trade) => {
    const allowed = STATUS_FILTERS[status];
    if (allowed && !allowed.includes(trade.status as never)) {
      return false;
    }
    if (!needle) {
      return true;
    }
    // What somebody has to hand when hunting for one trade: the counterparty
    // they agreed it with, a symbol, or an address off an explorer.
    return [
      trade.id,
      trade.swapDvp,
      trade.legs.a.symbol,
      trade.legs.b.symbol,
      trade.legs.a.mint,
      trade.legs.b.mint,
      trade.sdpSide === "a" ? trade.legs.b.party : trade.legs.a.party,
    ]
      .filter(Boolean)
      .some((value) => matchesAddressQuery(String(value), needle));
  });

  const listIsEmpty = trades.length === 0;
  const filteredToNothing = !listIsEmpty && visible.length === 0;
  const createHref = `${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/create`;
  return (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <div className="mx-auto flex w-full max-w-[63rem] flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="max-w-3xl text-secondary text-sm">
            {t("DashboardMarkets.dvp.description")}
          </p>
          {/* Suppressed while the list is empty, because the empty state already
              carries this exact call to action and two of the same button on one
              screen reads as two different actions. */}
          {listIsEmpty ? null : (
            <Button asChild className="shrink-0" size="sm">
              <Link href={createHref}>
                <PlusIcon className="size-4" />
                {t("DashboardMarkets.dvp.createAction")}
              </Link>
            </Button>
          )}
        </div>

        {/* An error and a table of nothing say different things, and showing
            both says the list is empty when the truth is that it could not be
            read. The error stands alone. */}
        {error ? (
          <Callout live title={t("DashboardMarkets.dvp.listErrorTitle")} variant="danger">
            {error}
          </Callout>
        ) : listIsEmpty ? (
          <ListEmptyState
            action={
              <Button asChild size="sm">
                <Link href={createHref}>
                  <PlusIcon className="size-4" />
                  {t("DashboardMarkets.dvp.createAction")}
                </Link>
              </Button>
            }
            description={t("DashboardMarkets.dvp.emptyDescription")}
            icon={<ArrowLeftRightIcon className="size-5" />}
            message={t("DashboardMarkets.dvp.empty")}
          />
        ) : (
          <>
            {/* Only once there is enough to sift. A filter bar over three rows
                is furniture. */}
            {trades.length > 1 ? (
              /* The toolbar every other workspace uses: the shared SearchInput
                 on the right, the status choices as one segmented control on
                 the left. This was a bare Input beside a Select, and Select's
                 trigger is w-full by design — so a two-word status filter
                 claimed the whole row and shoved the search onto a line of its
                 own, in a box too narrow to finish its own placeholder.

                 A segmented control also shows the four choices instead of
                 hiding them behind a chevron, which for four short labels is
                 what a dropdown costs you. Contained, so it can never shed an
                 orphaned pill onto a wrap line; on a narrow viewport it scrolls
                 inside its own strip. Matches the integrations catalog. */
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="overflow-x-auto [scrollbar-width:none]">
                  <SegmentedControl
                    aria-label={t("DashboardMarkets.dvp.filterStatusLabel")}
                    items={STATUS_FILTER_ORDER.map((option) => ({
                      value: option,
                      label: t(STATUS_FILTER_LABELS[option]),
                    }))}
                    // Re-clicking the active segment can emit an empty value
                    // from the underlying toggle group, and a status filter
                    // always has a selection.
                    onValueChange={(next) => next && setStatus(next as StatusFilter)}
                    value={status}
                  />
                </div>
                <div className="w-full md:w-64 md:shrink-0">
                  <SearchInput
                    aria-label={t("DashboardMarkets.dvp.filterSearchLabel")}
                    clear={{
                      label: t("DashboardMarkets.dvp.filterClearSearch"),
                      onClear: () => setQuery(""),
                    }}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder={t("DashboardMarkets.dvp.filterSearchPlaceholder")}
                    value={query}
                  />
                </div>
              </div>
            ) : null}

            {/* "Nothing matches" and "you have none" are different answers, and
                offering "create a trade" to somebody who just over-filtered
                sends them to make a second one they do not need. */}
            {filteredToNothing ? (
              <ListEmptyState
                action={
                  <Button
                    onClick={() => {
                      setStatus("all");
                      setQuery("");
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {t("DashboardMarkets.dvp.filterClear")}
                  </Button>
                }
                icon={<ArrowLeftRightIcon className="size-5" />}
                message={t("DashboardMarkets.dvp.filterNoMatches")}
              />
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border-default">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("DashboardMarkets.dvp.columnStatus")}</TableHead>
                      <TableHead>{t("DashboardMarkets.dvp.columnAsset")}</TableHead>
                      <TableHead>{t("DashboardMarkets.dvp.columnCash")}</TableHead>
                      <TableHead>{t("DashboardMarkets.dvp.columnCounterparty")}</TableHead>
                      <TableHead>{t("DashboardMarkets.dvp.columnCreated")}</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((trade) => {
                      const counterparty =
                        trade.sdpSide === "a" ? trade.legs.b.party : trade.legs.a.party;
                      // Marked on the row rather than announced in a banner: a
                      // warning that does not say WHICH trade sends an operator
                      // through every row to find it.
                      //
                      // The two conditions need different words. Labelling a frozen
                      // escrow "holds more than the trade needs" is not a vague
                      // warning, it is a false one, and it is the only thing a
                      // screen reader gets from this icon.
                      const isFrozen = frozenLegs(trade).length > 0;
                      const isOverFunded = overFundedLegs(trade).length > 0;
                      const attention = isFrozen
                        ? t("DashboardMarkets.dvp.frozenTitle")
                        : isOverFunded
                          ? t("DashboardMarkets.dvp.surplusTitle")
                          : null;
                      return (
                        // The whole row navigates, via a stretched link on the
                        // status cell. Actions live on the detail page.
                        <TableRow className="relative hover:bg-fill-subtle" key={trade.id}>
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
                            <LegCell closed={isDvpTradeClosed(trade)} leg={trade.legs.a} />
                          </TableCell>
                          <TableCell>
                            <LegCell closed={isDvpTradeClosed(trade)} leg={trade.legs.b} />
                          </TableCell>
                          <TableCell className="text-secondary text-sm">
                            {/* Shortened to read, copyable in full. A truncated
                                address is not an address: it cannot be pasted
                                into a wallet, an explorer or a message back to
                                the other side, which is most of what anyone
                                wants this column for. */}
                            <span className="inline-flex items-center gap-1">
                              <span className="sr-only">{counterparty}</span>
                              <span aria-hidden>{shortenAddress(counterparty)}</span>
                              <WalletAddressCopyButton
                                address={counterparty}
                                tooltip={counterparty}
                              />
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
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}

        {/* The list is capped and has no cursor upstream, so say so rather than
            letting it read as the complete set. */}
        {trades.length >= DVP_TRADES_PAGE_SIZE ? (
          <p className="text-tertiary text-xs">
            {t("DashboardMarkets.dvp.moreTrades", { count: String(DVP_TRADES_PAGE_SIZE) })}
          </p>
        ) : null}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
