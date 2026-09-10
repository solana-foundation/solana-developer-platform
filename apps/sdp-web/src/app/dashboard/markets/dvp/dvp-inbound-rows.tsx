"use client";

/**
 * Trades another organization set up that name one of this project's wallets.
 *
 * Rows in the existing table rather than a panel of their own. They were a
 * separate bordered block above the list at first, with its own heading,
 * description and second table — a lot of furniture for something that is empty
 * on most days and has one row on the rest, and it read as a banner rather than
 * as part of the page. One table, one grammar, and the count sits on the filter
 * control so a reader still learns there is something waiting without a block
 * announcing it.
 */

import Link from "next/link";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { formatTimestamp, shortenAddress } from "../../payments/payments-overview.utils";
import { formatLegAmount } from "./dvp-trade";
import type { DvpInboundLeg, DvpInboundTrade } from "./dvp-trades.data";
import { useDvpTradeActions } from "./use-dvp-trade-actions";

/** One leg, in the same shape the rest of the table uses. */
function InboundLegCell({ leg, yours }: { leg: DvpInboundLeg; yours: boolean }) {
  const t = useTranslations();

  return (
    <div className="min-w-0">
      <div className="truncate text-primary text-sm tabular-nums">
        {formatLegAmount(leg.amount, leg.decimals)}
        {leg.symbol ? <span className="ml-1 text-secondary">{leg.symbol}</span> : null}
      </div>
      <div className="truncate text-tertiary text-xs">
        {yours
          ? t("DashboardMarkets.dvp.inboundColumnYouDeliver")
          : t("DashboardMarkets.dvp.inboundColumnYouReceive")}
      </div>
    </div>
  );
}

/**
 * Funds the reader's own leg from the wallet whose key made it theirs.
 *
 * Clicked, not held: paying into an escrow is a step forward rather than
 * something to walk back, and hold-to-confirm is reserved for destroying
 * something. Still governed by this organization's own wallet policy, so it may
 * come back held for approval.
 *
 * Its own component so each row owns its pending state; one hook above the rows
 * would put every row into "Funding…" at once.
 */
function InboundFundAction({
  frozen,
  side,
  tradeId,
}: {
  frozen: boolean;
  /** The leg the custody lookup made this caller's. */
  side: "a" | "b";
  tradeId: string;
}) {
  const t = useTranslations();
  const { act, awaitingApproval, error, pending } = useDvpTradeActions(tradeId);

  return (
    <span className="relative z-10 flex flex-col items-end gap-1">
      <Button
        // A transfer into a frozen escrow bounces, so offering to send one is
        // offering to waste a signature and a fee.
        disabled={frozen || pending !== null || awaitingApproval}
        onClick={() => act("fund", { side })}
        size="sm"
        type="button"
        variant="secondary"
      >
        {pending === "fund"
          ? t("DashboardMarkets.dvp.inboundFunding")
          : t("DashboardMarkets.dvp.inboundFundAction")}
      </Button>
      {error ? <span className="max-w-56 text-error text-xs">{error}</span> : null}
    </span>
  );
}

export function InboundRows({ trades }: { trades: DvpInboundTrade[] }) {
  const t = useTranslations();

  return trades.map((trade) => {
    const yours = trade.yourSide === "a" ? trade.legs.a : trade.legs.b;
    // Funded from this reader's side once their escrow holds the target. The
    // trade's own status describes both legs at once and cannot answer this.
    const funded =
      yours.observedAmount !== null && BigInt(yours.observedAmount) >= BigInt(yours.amount);

    return (
      <TableRow className="relative hover:bg-fill-subtle" key={trade.id}>
        <TableCell>
          <Link
            className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
            href={`${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/${trade.id}`}
          >
            <Badge variant={funded ? "success" : "warning"}>
              {t(
                funded
                  ? "DashboardMarkets.dvp.inboundFunded"
                  : "DashboardMarkets.dvp.inboundBadgeWaiting"
              )}
            </Badge>
          </Link>
        </TableCell>
        <TableCell>
          <InboundLegCell leg={trade.legs.a} yours={trade.yourSide === "a"} />
        </TableCell>
        <TableCell>
          <InboundLegCell leg={trade.legs.b} yours={trade.yourSide === "b"} />
        </TableCell>
        <TableCell className="text-secondary text-sm">
          {/* The escrow, not the parties. On a trade somebody else set up this
              is the only address a reader acts on, and the column is the one
              place they would look for it. */}
          <span className="relative z-10 flex flex-col gap-1">
            <span className="inline-flex items-center gap-1">
              <span className="sr-only">{yours.escrow}</span>
              <span aria-hidden>{shortenAddress(yours.escrow)}</span>
              <WalletAddressCopyButton address={yours.escrow} tooltip={yours.escrow} />
            </span>
            {/* Disabling the funding button is not enough on its own: the
                address next to it stays copyable, so somebody can pay a frozen
                escrow by hand and lose the fee to a transfer that was always
                going to bounce. The warning belongs where the address is. */}
            {yours.frozen === true ? (
              <span className="text-warning text-xs">
                {t("DashboardMarkets.dvp.inboundFrozen")}
              </span>
            ) : null}
          </span>
        </TableCell>
        <TableCell className="text-secondary text-sm">
          {formatTimestamp(new Date(Number(trade.expiryTimestamp) * 1000).toISOString(), t)}
        </TableCell>
        <TableCell>
          {funded ? null : (
            <InboundFundAction
              frozen={yours.frozen === true}
              side={trade.yourSide}
              tradeId={trade.id}
            />
          )}
        </TableCell>
      </TableRow>
    );
  });
}
