"use client";

import type { DvpTradeSide, DvpTradeStatus, SolanaCluster } from "@sdp/types";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  InfoIcon,
  type LucideIcon,
  SnowflakeIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import { Fragment, type ReactNode, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { EntityLink } from "@/components/entity-link";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { HeightReveal } from "@/components/ui/height-reveal";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "../../activity-format-utils";
import { formatTimestamp } from "../../payments/payments-overview.utils";
import { DvpCloseActions } from "./dvp-close-actions";
import { DvpNextStep } from "./dvp-next-step";
import { DvpStatusBadge } from "./dvp-status";
import {
  type DvpPartyRef,
  type DvpTrade,
  type DvpTradeKind,
  type DvpTradeLeg,
  formatLegAmount,
  frozenLegs,
  isDvpPartyView,
  isDvpTradeClosed,
  legFundingRatio,
  overFundedLegs,
} from "./dvp-trade";
import { useDvpTradeActions } from "./use-dvp-trade-actions";

/**
 * An address with a copy affordance.
 *
 * Escrow addresses are the product: a counterparty funds a leg by sending an
 * ordinary transfer to one, so it has to leave this page intact. The full value
 * goes on the clipboard while the display stays shortened — copying a truncated
 * address would send tokens nowhere.
 */
function CopyableAddress({
  address,
  label,
  className,
}: {
  address: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className={cn(
        "inline-flex max-w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left font-mono text-secondary text-xs transition-colors hover:bg-fill-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong",
        className
      )}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // A clipboard the browser refuses is not worth an error state; the
          // address is still selectable in the title attribute.
        }
      }}
      title={address}
      type="button"
    >
      {/* In full. These are the addresses a counterparty pays into and the
          accounts a trade is verified against — a shortened one cannot be
          checked against anything, and reading half of it is how somebody
          confirms the wrong account. `break-all` because base58 has no spaces
          to wrap at. */}
      <span className="break-all">{address}</span>
      {copied ? (
        <CheckIcon aria-hidden className="h-3 w-3 shrink-0 text-success" />
      ) : (
        <CopyIcon aria-hidden className="h-3 w-3 shrink-0" />
      )}
      <span className="sr-only">{label}</span>
    </button>
  );
}

/** A transaction signature as an explorer link: nobody reads one, they follow it. */
function TransactionLink({ signature, cluster }: { signature: string; cluster: SolanaCluster }) {
  return (
    <a
      className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
      href={explorerTxUrl(signature, cluster)}
      rel="noreferrer noopener"
      target="_blank"
    >
      <span className="font-mono">{`${signature.slice(0, 8)}…${signature.slice(-8)}`}</span>
      <ExternalLinkIcon aria-hidden className="h-3 w-3 shrink-0" />
    </a>
  );
}

/**
 * How a closed trade ended for its legs.
 *
 * `closed` alone was forcing every finished leg to read as delivered, which
 * is a false statement about a cancelled or rejected trade: those refunded each
 * leg to whoever deposited it. Only `settled` delivered anything. An expired
 * trade is neither: its escrows still hold whatever was deposited until a
 * cancel returns it, so the leg keeps its real amount and stops taking deposits.
 */
type LegOutcome = "open" | "expired" | "settled" | "refunded" | "closed";

function legOutcome(status: DvpTradeStatus): LegOutcome {
  switch (status) {
    case "settled":
      return "settled";
    case "cancelled":
    case "rejected":
      return "refunded";
    case "closed_unknown":
    case "create_failed":
      return "closed";
    case "expired":
      return "expired";
    case "creating":
    case "created":
    case "partially_funded":
    case "funded":
      return "open";
    default: {
      const unreachable: never = status;
      throw new Error(`Unhandled DvP trade status ${String(unreachable)}`);
    }
  }
}

/**
 * The one thing true of this leg right now, as an icon and a label.
 *
 * Derived from the condition that actually fired rather than from a single
 * flag: an icon's accessible name is the whole of what a screen reader gets
 * from it, and a warning triangle captioned for the wrong reason is worse than
 * no icon at all.
 */
function legStatus(
  leg: DvpTradeLeg,
  outcome: LegOutcome
): { Icon: LucideIcon; tone: string; bar: string; key: MessageKey } {
  switch (outcome) {
    case "settled":
      return {
        Icon: CircleCheckIcon,
        tone: "text-success",
        bar: "bg-success",
        key: "DashboardMarkets.dvp.legDelivered",
      };
    case "refunded":
      return {
        Icon: CircleCheckIcon,
        tone: "text-tertiary",
        bar: "bg-fill-strong",
        key: "DashboardMarkets.dvp.legRefunded",
      };
    case "closed":
      return {
        Icon: CircleCheckIcon,
        tone: "text-tertiary",
        bar: "bg-fill-strong",
        key: "DashboardMarkets.dvp.legClosed",
      };
    case "expired":
      return {
        Icon: ClockIcon,
        tone: "text-warning",
        bar: "bg-warning",
        key: "DashboardMarkets.dvp.legExpired",
      };
    case "open":
      break;
  }
  if (leg.funding?.frozen) {
    return {
      Icon: SnowflakeIcon,
      tone: "text-warning",
      bar: "bg-warning",
      key: "DashboardMarkets.dvp.legFrozen",
    };
  }
  if (leg.funding?.surplus) {
    return {
      Icon: TriangleAlertIcon,
      tone: "text-warning",
      bar: "bg-warning",
      key: "DashboardMarkets.dvp.legOverFunded",
    };
  }
  if (leg.funding?.funded) {
    return {
      Icon: CircleCheckIcon,
      tone: "text-success",
      bar: "bg-success",
      key: "DashboardMarkets.dvp.legFunded",
    };
  }
  return {
    Icon: ClockIcon,
    tone: "text-tertiary",
    bar: "bg-info",
    key: "DashboardMarkets.dvp.legAwaiting",
  };
}

/**
 * The caption for a leg held by a bare external address: a party of the trade,
 * named by its slot. Wallets and registered counterparties are linked instead
 * ({@link PartyLink}).
 */
function holderLabel(t: ReturnType<typeof useTranslations>, side: DvpTradeSide): string {
  return t(side === "a" ? "DashboardMarkets.dvp.legPartyA" : "DashboardMarkets.dvp.legPartyB");
}

/**
 * Which words the exchange summary uses for each side.
 *
 * Past tense once the trade settled; a cancelled trade delivered nothing. A
 * bilateral trade is two of the caller's
 * own legs going the other way, so "you deliver" / "you receive" has no single
 * referent — the party words are the honest ones there, and for an agent too.
 */
function exchangeLabelKeys(
  kind: DvpTradeKind,
  settled: boolean
): { given: MessageKey; taken: MessageKey } {
  if (kind === "principal") {
    return settled
      ? { given: "DashboardMarkets.dvp.youDelivered", taken: "DashboardMarkets.dvp.youReceived" }
      : { given: "DashboardMarkets.dvp.youDeliver", taken: "DashboardMarkets.dvp.youReceive" };
  }
  return settled
    ? {
        given: "DashboardMarkets.dvp.summaryPartyADelivered",
        taken: "DashboardMarkets.dvp.summaryPartyBDelivered",
      }
    : {
        given: "DashboardMarkets.dvp.summaryPartyADelivers",
        taken: "DashboardMarkets.dvp.summaryPartyBDelivers",
      };
}

/** "You deliver 100 UDVP · you receive 100 USDC", from the caller's side. */
function ExchangeSummary({ trade }: { trade: DvpTrade }) {
  const t = useTranslations();
  const labels = exchangeLabelKeys(trade.kind, trade.status === "settled");
  // On a principal trade the caller's leg is "given"; the party words are
  // fixed to A then B and need no swap.
  const [given, taken] =
    trade.kind === "principal" && trade.legs.b.party.wallet !== null
      ? [trade.legs.b, trade.legs.a]
      : [trade.legs.a, trade.legs.b];
  const amount = (leg: DvpTradeLeg) =>
    `${formatLegAmount(leg.amount, leg.decimals)}${leg.symbol ? ` ${leg.symbol}` : ""}`;
  return (
    <span className="text-secondary text-sm">
      {t(labels.given)} {amount(given)} · {t(labels.taken)} {amount(taken)}
    </span>
  );
}

/** A token's mark: the first letter of its symbol in a circle, until mints carry logos. */
function TokenMark({ symbol }: { symbol: string }) {
  return (
    <span
      aria-hidden
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-fill font-semibold text-primary text-sm"
    >
      {symbol.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The line under the amount: progress while open, the outcome once closed. */
function legProgressCaption(
  t: ReturnType<typeof useTranslations>,
  outcome: LegOutcome,
  held: string,
  target: string
): string {
  switch (outcome) {
    case "settled":
      return t("DashboardMarkets.dvp.deliveredLabel");
    case "refunded":
      return t("DashboardMarkets.dvp.refundedLabel");
    case "closed":
      return t("DashboardMarkets.dvp.closedLabel");
    case "open":
    case "expired":
      return `${held} / ${target}`;
  }
}

/**
 * One leg as a fund manager reads it: what it is, who holds it, whether it has
 * arrived, and the transaction that brought it. No addresses; those live in the
 * on-chain details at the foot of the page.
 */
function LegCard({
  action,
  outcome,
  cluster,
  leg,
  side,
}: {
  action: ReactNode | undefined;
  outcome: LegOutcome;
  cluster: SolanaCluster;
  leg: DvpTradeLeg;
  side: DvpTradeSide;
}) {
  const t = useTranslations();
  const status = legStatus(leg, outcome);
  const ratio =
    outcome === "settled"
      ? 1
      : outcome === "open" || outcome === "expired"
        ? legFundingRatio(leg)
        : 0;
  const percent = ratio === null ? 0 : Math.round(Math.min(ratio, 1) * 100);
  const target = formatLegAmount(leg.amount, leg.decimals);
  const held = leg.funding ? formatLegAmount(leg.funding.observedAmount, leg.decimals) : "0";

  return (
    <section className="flex flex-col rounded-2xl border border-border-default bg-surface-raised p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="flex flex-wrap items-center gap-x-2 font-medium text-base text-primary leading-6">
          {t(side === "a" ? "DashboardMarkets.dvp.legA" : "DashboardMarkets.dvp.legB")}
          <span
            className={cn(
              "inline-flex items-center gap-1 font-normal text-xs leading-6",
              status.tone
            )}
          >
            <status.Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
            {t(status.key)}
          </span>
        </h3>
        <span className="text-sm text-tertiary">
          {leg.party.wallet || leg.party.counterparty ? (
            <PartyLink party={leg.party} />
          ) : (
            holderLabel(t, side)
          )}
        </span>
      </div>
      {/* Where this party pays in, directly under who they are. Only while the
          escrow can still receive: once the leg is funded, frozen, or the trade
          is closed, an address here is an invitation to send tokens somewhere
          they will bounce or are not wanted. */}
      {outcome !== "open" || leg.funding?.funded || leg.funding?.frozen ? null : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-fill-subtle px-3 py-2">
          <span className="text-[11px] text-tertiary">{t("DashboardMarkets.dvp.escrowLabel")}</span>
          <CopyableAddress
            address={leg.escrow}
            className="px-0 hover:bg-transparent"
            label={t("DashboardMarkets.dvp.escrowLabel")}
          />
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        {leg.symbol ? <TokenMark symbol={leg.symbol} /> : null}
        <p className="font-semibold text-3xl text-primary tracking-tight tabular-nums">
          {target}
          {leg.symbol ? (
            <span className="ml-2 font-medium text-secondary text-xl">{leg.symbol}</span>
          ) : null}
        </p>
      </div>

      <div className="mt-5 flex items-center justify-between text-secondary text-xs tabular-nums">
        <span>{legProgressCaption(t, outcome, held, target)}</span>
        <span>{percent}%</span>
      </div>
      <div
        aria-label={t("DashboardMarkets.dvp.fundedLabel")}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-fill-subtle"
        role="progressbar"
      >
        <div className={cn("h-full rounded-full", status.bar)} style={{ width: `${percent}%` }} />
      </div>

      {leg.fundingSignature ? (
        <p className="mt-4 text-secondary text-xs">
          {t("DashboardMarkets.dvp.txFunding")}{" "}
          <TransactionLink cluster={cluster} signature={leg.fundingSignature} />
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </section>
  );
}

/**
 * A table cell for an on-chain value: the full address or signature with copy,
 * and a way out to the explorer. Full, not shortened — in a column of values a
 * reader compares against a wallet or an explorer, half of one is no use.
 */
function ChainValueCell({ value, href }: { value: string; href: string }) {
  const t = useTranslations();
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <CopyableAddress
        address={value}
        className="px-0 hover:bg-transparent"
        label={t("DashboardMarkets.dvp.detailsAddress")}
      />
      <a
        aria-label={t("DashboardMarkets.dvp.viewOnExplorer")}
        className="text-tertiary hover:text-primary"
        href={href}
        rel="noreferrer noopener"
        target="_blank"
      >
        <ExternalLinkIcon aria-hidden className="h-3 w-3" />
      </a>
    </span>
  );
}

/** The link to a party's own page, when it is a wallet or a registered counterparty. */
function PartyLink({ party }: { party: DvpPartyRef }) {
  const t = useTranslations();
  if (party.wallet) {
    return (
      <EntityLink href={`/dashboard/wallets/${encodeURIComponent(party.wallet.id)}`}>
        {party.wallet.name === null ? t("DashboardMarkets.dvp.partySdpWallet") : party.wallet.name}
      </EntityLink>
    );
  }
  if (party.counterparty) {
    return (
      <EntityLink
        href={`/dashboard/payments/counterparty/${encodeURIComponent(party.counterparty.id)}`}
      >
        {party.counterparty.label}
      </EntityLink>
    );
  }
  return null;
}

/**
 * Every account and transaction behind the trade, folded away.
 *
 * The page above answers a fund manager's questions without an address in
 * sight. The escrow addresses still have to be reachable, because paying into
 * one is how a counterparty funds a leg, and everything else here is what an
 * ops person or an on-chain enthusiast checks the trade against. Closed by
 * default; the table mounts on open and slides in, so nothing below it jumps.
 */
function OnChainDetails({ cluster, trade }: { cluster: SolanaCluster; trade: DvpTrade }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const accounts: { role: ReactNode; address: string }[] = [
    { role: t("DashboardMarkets.dvp.onChainAddress"), address: trade.swapDvp },
    { role: t("DashboardMarkets.dvp.settlementAuthority"), address: trade.settlementAuthority },
    {
      role: (
        <span className="flex items-center gap-2">
          {t("DashboardMarkets.dvp.legPartyA")}
          <PartyLink party={trade.legs.a.party} />
        </span>
      ),
      address: trade.legs.a.party.address,
    },
    {
      role: (
        <span className="flex items-center gap-2">
          {t("DashboardMarkets.dvp.legPartyB")}
          <PartyLink party={trade.legs.b.party} />
        </span>
      ),
      address: trade.legs.b.party.address,
    },
    { role: t("DashboardMarkets.dvp.escrowA"), address: trade.legs.a.escrow },
    { role: t("DashboardMarkets.dvp.escrowB"), address: trade.legs.b.escrow },
  ];
  const transactions = [
    { role: t("DashboardMarkets.dvp.txCreate"), signature: trade.createSignature },
    { role: t("DashboardMarkets.dvp.txClose"), signature: trade.closeSignature },
  ].flatMap((row) => (row.signature ? [{ role: row.role, signature: row.signature }] : []));

  return (
    <section>
      <button
        aria-expanded={open}
        className="flex items-center gap-1.5 font-medium text-primary text-sm"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("h-4 w-4 text-tertiary transition-transform", open && "rotate-90")}
        />
        {t("DashboardMarkets.dvp.onChainDetails")}
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <HeightReveal key="on-chain-details">
            {/* Padding, not margin: the reveal measures its child's offsetHeight,
                and a top margin collapses out of that, clipping the table's
                last row by the same amount. */}
            <div className="overflow-x-auto pt-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[30%]">
                      {t("DashboardMarkets.dvp.detailsRole")}
                    </TableHead>
                    <TableHead>{t("DashboardMarkets.dvp.detailsAddress")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((row) => (
                    <TableRow key={row.address + String(row.role)}>
                      <TableCell className="text-secondary text-sm">{row.role}</TableCell>
                      <TableCell>
                        <ChainValueCell
                          href={explorerAddressUrl(row.address, cluster)}
                          value={row.address}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {transactions.map((row) => (
                    <TableRow key={row.signature}>
                      <TableCell className="text-secondary text-sm">{row.role}</TableCell>
                      <TableCell>
                        <ChainValueCell
                          href={explorerTxUrl(row.signature, cluster)}
                          value={row.signature}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {trade.refString ? (
                    <TableRow>
                      <TableCell className="text-secondary text-sm">
                        {t("DashboardMarkets.dvp.fieldRef")}
                      </TableCell>
                      <TableCell className="text-primary text-sm">{trade.refString}</TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </HeightReveal>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

/**
 * A moment written out in full for one zone, with the zone's name split off so
 * two zones can be laid out as aligned columns.
 */
function formatZoned(date: Date, timeZone: string | undefined): { when: string; zone: string } {
  const parts = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).formatToParts(date);
  const zone = parts.find((part) => part.type === "timeZoneName");
  const when = parts
    .filter((part) => part.type !== "timeZoneName")
    .map((part) => part.value)
    .join("")
    .trim()
    .replace(/,$/, "");
  return { when, zone: zone ? zone.value : "" };
}

/**
 * One dated fact about the trade: a label, the local time, and an info mark
 * whose tooltip spells the exact moment out in the reader's zone and in UTC.
 *
 * Local time depends on the browser, so the server renders it in its own zone
 * and the client corrects it on hydration; the mismatch warning is silenced
 * for exactly that span.
 */
function TimestampFact({
  label,
  iso,
  children,
}: {
  label: string;
  iso: string;
  /** Anything to say after the time, such as a countdown. */
  children?: ReactNode;
}) {
  const t = useTranslations();
  const date = new Date(iso);
  return (
    <span className="flex items-center gap-1.5">
      <span>{label}</span>
      <span className="text-secondary" suppressHydrationWarning>
        {formatTimestamp(iso, t)}
      </span>
      {children}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={t("DashboardMarkets.dvp.exactTime")}
            className="text-tertiary hover:text-primary"
            type="button"
          >
            <InfoIcon aria-hidden className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="text-xs tabular-nums" side="bottom">
          <span className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
            {[formatZoned(date, undefined), formatZoned(date, "UTC")].map((zoned) => (
              <Fragment key={zoned.zone}>
                <span>{zoned.when}</span>
                <span className="text-right text-tertiary">{zoned.zone}</span>
              </Fragment>
            ))}
          </span>
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

/**
 * Everything wrong with a trade that is worth saying before somebody acts.
 *
 * Its own component because these are three independent conditions that share
 * only a position on the page, and holding them inline meant the workspace's
 * control flow was mostly this. Each decides for itself whether it applies.
 */
function TradeWarnings({ trade }: { trade: DvpTrade }) {
  const t = useTranslations();
  const frozen = frozenLegs(trade);
  const overFunded = overFundedLegs(trade);
  // A leg paying out somewhere other than the address that funds it.
  // Legitimate and ordinary for an execution desk, and simultaneously the
  // exact shape of a forged trade: create is permissionless and the economic
  // terms are not bound by the trade's address, so anyone can publish a trade
  // naming you with the proceeds pointed at themselves. Rendering the redirect
  // silently is what would make that work.
  const redirected = [trade.legs.a, trade.legs.b].filter(
    (leg) => leg.settlementDestination !== leg.party.address
  );

  return (
    <>
      {redirected.length > 0 ? (
        <Callout title={t("DashboardMarkets.dvp.destinationDiffersTitle")} variant="warning">
          <span className="inline-flex items-start gap-2">
            <TriangleAlertIcon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {t("DashboardMarkets.dvp.destinationDiffersBody")}
              <span className="mt-2 block">
                {redirected.map((leg) => (
                  <span className="block text-xs" key={leg.settlementDestination}>
                    {t("DashboardMarkets.dvp.destinationDiffersLeg", {
                      address: leg.settlementDestination,
                    })}
                  </span>
                ))}
              </span>
            </span>
          </span>
        </Callout>
      ) : null}

      {frozen.length > 0 ? (
        <Callout title={t("DashboardMarkets.dvp.frozenTitle")} variant="warning">
          <span className="inline-flex items-start gap-2">
            <SnowflakeIcon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            {t("DashboardMarkets.dvp.frozenDescription")}
          </span>
        </Callout>
      ) : null}

      {overFunded.length > 0 ? (
        <Callout title={t("DashboardMarkets.dvp.surplusTitle")} variant="warning">
          <span className="inline-flex items-start gap-2">
            <TriangleAlertIcon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            {t("DashboardMarkets.dvp.surplusDescription")}
          </span>
        </Callout>
      ) : null}
    </>
  );
}

/**
 * Whether the caller may fund a leg right now.
 *
 * The API says which sides are the caller's via `party.wallet`; beyond that the
 * escrow has to still be payable: the trade must not be over, the leg must not
 * already hold its target, and a frozen escrow bounces transfers.
 */
function canFundLeg(leg: DvpTradeLeg, status: DvpTrade["status"]): boolean {
  const fundableStatus = status === "created" || status === "partially_funded";
  return (
    leg.party.wallet !== null && fundableStatus && !leg.funding?.funded && !leg.funding?.frozen
  );
}

export function DvpTradeDetailWorkspace({
  trade,
  cluster,
}: {
  trade: DvpTrade;
  /**
   * Passed in rather than read from context, so this stays a pure function of
   * its props — the same split `dvp-create-client.tsx` already makes, and what
   * keeps the workspace renderable in a test without a provider around it.
   */
  cluster: SolanaCluster;
}) {
  const tradeClosed = isDvpTradeClosed(trade);
  const outcome = legOutcome(trade.status);
  const t = useTranslations();
  const { act, awaitingApproval, error, pending } = useDvpTradeActions(trade.id);
  const partyView = isDvpPartyView(trade);
  const expiry = new Date(Number(trade.expiryTimestamp) * 1000).toISOString();

  // One fund action per custodied side: a bilateral trade funds both legs,
  // each from the wallet that holds its party address, through the unified
  // fund endpoint naming the side.
  const fundActionFor = (side: DvpTradeSide): ReactNode =>
    canFundLeg(trade.legs[side], trade.status) ? (
      <div className="flex flex-col gap-2">
        {/* Clicked, not held. Funding moves your leg into the trade's own
            escrow, which is a step forward rather than something to walk back;
            hold is reserved for destroying something (HOO-1230). */}
        <Button
          className="self-start"
          disabled={pending !== null}
          onClick={() => act("fund", { side })}
          type="button"
        >
          {t("DashboardMarkets.dvp.actionFund")}
        </Button>
        <p className="text-[11px] text-tertiary leading-relaxed">
          {t("DashboardMarkets.dvp.fundHint")}
        </p>
      </div>
    ) : undefined;

  // Your leg first, whichever it is. With no custodied leg (agent) or both
  // custodied (bilateral) the trade's own asset-then-cash order stays.
  const custodiedA = trade.legs.a.party.wallet !== null;
  const custodiedB = trade.legs.b.party.wallet !== null;
  const sides: DvpTradeSide[] = custodiedB && !custodiedA ? ["b", "a"] : ["a", "b"];

  return (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <div className="mx-auto flex w-full max-w-[63rem] flex-col gap-8">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <DvpStatusBadge status={trade.status} />
            <TooltipProvider>
              <div className="flex flex-wrap items-center gap-3 text-tertiary text-xs">
                <TimestampFact
                  iso={trade.createdAt}
                  label={t("DashboardMarkets.dvp.columnCreated")}
                />
                {tradeClosed ? null : (
                  <>
                    <span aria-hidden className="h-4 w-px bg-border-default" />
                    <TimestampFact iso={expiry} label={t("DashboardMarkets.dvp.fieldExpiry")}>
                      <span suppressHydrationWarning>({formatRelativeTime(expiry)})</span>
                    </TimestampFact>
                  </>
                )}
              </div>
            </TooltipProvider>
          </div>
          <DvpNextStep trade={trade} />
        </div>

        <TradeWarnings trade={trade} />

        <section>
          <div className="flex flex-wrap items-center gap-4">
            <h2 className="font-medium text-lg text-primary tracking-tight">
              {t("DashboardMarkets.dvp.legsHeading")}
            </h2>
            <span aria-hidden className="hidden h-px flex-1 bg-border-subtle sm:block" />
            <ExchangeSummary trade={trade} />
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {sides.map((side) => (
              <LegCard
                action={fundActionFor(side)}
                cluster={cluster}
                key={side}
                outcome={outcome}
                leg={trade.legs[side]}
                side={side}
              />
            ))}
          </div>
        </section>

        {awaitingApproval ? (
          <Callout live title={t("DashboardMarkets.dvp.approvalPending")} variant="info">
            {t("DashboardMarkets.dvp.approvalPendingDescription")}
          </Callout>
        ) : null}
        {error ? (
          <Callout live variant="danger">
            {error}
          </Callout>
        ) : null}

        {/* Only the settlement authority can settle or cancel, and a party
            reading somebody else's trade is not it. Offering the buttons put
            two irreversible-looking actions in front of somebody whose click
            could only ever come back "trade not found". */}
        {partyView ? (
          <p className="text-tertiary text-xs leading-relaxed">
            {t("DashboardMarkets.dvp.partyHoldsLeg")}
          </p>
        ) : (
          <DvpCloseActions onAct={act} pending={pending} trade={trade} />
        )}

        <OnChainDetails cluster={cluster} trade={trade} />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
