"use client";

/**
 * Trades somebody else set up that are waiting on this project.
 *
 * Above the main list rather than behind a tab, because a trade waiting on you
 * is the only thing on this page with a deadline attached: it expires, and
 * until it is funded nothing on the other side moves either. A tab would make
 * the one time-sensitive item on the page the one item you have to go looking
 * for.
 *
 * Renders nothing at all when there is nothing waiting. An empty panel would
 * appear on every visit for every project that never counterparties a trade,
 * which is most of them, and a permanent "nothing here" is chrome rather than
 * information. The main list already carries the page's empty state.
 */

import { AlertTriangleIcon, ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
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
import { formatLegAmount } from "./dvp-trade";
import type { DvpInboundLeg, DvpInboundTrade } from "./dvp-trades.data";

/** An amount and its symbol, in the direction it moves for the reader. */
function InboundAmount({ leg, outgoing }: { leg: DvpInboundLeg; outgoing: boolean }) {
  const Icon = outgoing ? ArrowUpRightIcon : ArrowDownLeftIcon;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon
        aria-hidden
        className={outgoing ? "size-3.5 shrink-0 text-tertiary" : "size-3.5 shrink-0 text-success"}
      />
      <div className="min-w-0">
        <div className="truncate text-primary text-sm tabular-nums">
          {formatLegAmount(leg.amount, leg.decimals)}
          {leg.symbol ? ` ${leg.symbol}` : ""}
        </div>
        <div className="truncate text-tertiary text-xs">{shortenAddress(leg.mint)}</div>
      </div>
    </div>
  );
}

export function DvpInboundPanel({ trades }: { trades: DvpInboundTrade[] }) {
  const t = useTranslations();

  if (trades.length === 0) {
    return null;
  }

  return (
    // One bordered block, so it reads as a distinct thing rather than as loose
    // text floating above the list. The heading, the caution and the rows all
    // belong to the same object and the border is what says so.
    <section className="overflow-hidden rounded-xl border border-border-default bg-surface-raised">
      <div className="grid gap-1.5 border-border-subtle border-b px-4 py-3">
        <h2 className="font-medium text-primary text-sm">
          {t("DashboardMarkets.dvp.inboundTitle")}
        </h2>
        <p className="max-w-3xl text-secondary text-sm">
          {t("DashboardMarkets.dvp.inboundDescription")}
        </p>
        {/* The terms were written by somebody else while this reader was not
            present, and the escrow address is the thing they are about to send
            money to. Inside the block, above the rows, so it is read before the
            addresses rather than after. */}
        <p className="flex items-start gap-2 text-tertiary text-xs leading-relaxed">
          <AlertTriangleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          {t("DashboardMarkets.dvp.inboundVerifyHint")}
        </p>
      </div>

      <div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("DashboardMarkets.dvp.inboundColumnYouDeliver")}</TableHead>
                <TableHead>{t("DashboardMarkets.dvp.inboundColumnYouReceive")}</TableHead>
                <TableHead>{t("DashboardMarkets.dvp.inboundColumnFund")}</TableHead>
                <TableHead>{t("DashboardMarkets.dvp.inboundColumnExpires")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((trade) => {
                const yours = trade.yourSide === "a" ? trade.legs.a : trade.legs.b;
                const theirs = trade.yourSide === "a" ? trade.legs.b : trade.legs.a;
                // A leg is settled from the reader's side once the escrow holds
                // the target. Comparing the observed balance is the only honest
                // reading: the trade's own status describes both legs at once.
                const funded =
                  yours.observedAmount !== null &&
                  BigInt(yours.observedAmount) >= BigInt(yours.amount);

                return (
                  <TableRow className="relative hover:bg-fill-subtle" key={trade.id}>
                    <TableCell>
                      <Link
                        className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
                        href={`${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/${trade.id}`}
                      >
                        <InboundAmount leg={yours} outgoing />
                      </Link>
                    </TableCell>
                    <TableCell>
                      <InboundAmount leg={theirs} outgoing={false} />
                    </TableCell>
                    <TableCell>
                      {funded ? (
                        <span className="text-success text-sm">
                          {t("DashboardMarkets.dvp.inboundFunded")}
                        </span>
                      ) : (
                        // Above the copy button rather than beside it: a frozen
                        // escrow bounces the transfer, so it has to be read
                        // before the address is taken, not after.
                        <div className="grid gap-1">
                          {yours.frozen ? (
                            <span className="text-warning text-xs">
                              {t("DashboardMarkets.dvp.inboundFrozen")}
                            </span>
                          ) : null}
                          <span className="relative z-10 inline-flex items-center gap-1 text-sm">
                            <span className="sr-only">{yours.escrow}</span>
                            <span aria-hidden>{shortenAddress(yours.escrow)}</span>
                            <WalletAddressCopyButton
                              address={yours.escrow}
                              tooltip={yours.escrow}
                            />
                          </span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-secondary text-sm">
                      {formatTimestamp(
                        new Date(Number(trade.expiryTimestamp) * 1000).toISOString(),
                        t
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </section>
  );
}
