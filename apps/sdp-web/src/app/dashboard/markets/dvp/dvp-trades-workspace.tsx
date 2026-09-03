"use client";

import { ArrowLeftRightIcon, ChevronRightIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { formatTimestamp, shortenAddress } from "../../payments/payments-overview.utils";
import { DvpStatusBadge } from "./dvp-status";
import { type DvpTrade, type DvpTradeLeg, frozenLegs, overFundedLegs } from "./dvp-trade";
import { DVP_TRADES_PAGE_SIZE } from "./dvp-trades.data";

/**
 * A leg as one cell: what it is worth, and whether the escrow has it.
 *
 * The observed amount is shown next to the target rather than instead of it,
 * because "1000 of 1000" and "1000" answer different questions and only the
 * first says whether anything is still owed.
 */
function LegCell({ leg }: { leg: DvpTradeLeg }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* The mark resolves only for a mint in the well-known registry; an
          issued asset falls back to a monogram rather than a blank. */}
      <TokenMark className="shrink-0" mint={leg.mint} size="sm" />
      <div className="min-w-0">
        {/* Observed-over-target once anything has read the escrow. Before that
            only the target is shown, with the status column carrying "not
            checked" so the two are never confused. */}
        <div className="truncate font-medium text-primary text-sm tabular-nums">
          {leg.funding ? `${leg.funding.observedAmount} / ${leg.amount}` : leg.amount}
        </div>
        <div className="truncate text-tertiary text-xs">{shortenAddress(leg.mint)}</div>
      </div>
    </div>
  );
}

export function DvpTradesWorkspace({
  trades,
  error,
}: {
  trades: DvpTrade[];
  error: string | null;
}) {
  const t = useTranslations();
  const listIsEmpty = trades.length === 0;
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
                {trades.map((trade) => {
                  const counterparty =
                    trade.sdpSide === "a" ? trade.legs.b.party : trade.legs.a.party;
                  // Marked on the row rather than announced in a banner: a
                  // warning that does not say WHICH trade sends an operator
                  // through every row to find it.
                  const attention =
                    overFundedLegs(trade).length > 0 || frozenLegs(trade).length > 0;
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
                              aria-label={t("DashboardMarkets.dvp.surplusTitle")}
                              className="h-3.5 w-3.5 shrink-0 text-warning"
                            />
                          ) : null}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <LegCell leg={trade.legs.a} />
                      </TableCell>
                      <TableCell>
                        <LegCell leg={trade.legs.b} />
                      </TableCell>
                      <TableCell className="text-secondary text-sm">
                        {shortenAddress(counterparty)}
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
