"use client";

import type { DvpTradeSide, SolanaCluster } from "@sdp/types";
import {
  ArrowLeftRightIcon,
  CheckIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  type LucideIcon,
  SnowflakeIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { EntityLink } from "@/components/entity-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer";

import { cn } from "@/lib/utils";
import { formatTimestamp } from "../../payments/payments-overview.utils";
import { DvpCloseActions } from "./dvp-close-actions";
import { DvpNextStep } from "./dvp-next-step";
import { DvpStatusBadge } from "./dvp-status";
import {
  custodiedSidesOf,
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

/** The badge copy for the derived kind, from the caller's viewpoint. */
const KIND_BADGE_KEY: Record<DvpTradeKind, MessageKey> = {
  principal: "DashboardMarkets.dvp.kindPrincipalBadge",
  agent: "DashboardMarkets.dvp.kindAgentBadge",
  bilateral: "DashboardMarkets.dvp.kindBilateralBadge",
};

/**
 * An address with a copy affordance.
 *
 * Escrow addresses are the product: a counterparty funds a leg by sending an
 * ordinary transfer to one, so it has to leave this page intact. The full value
 * goes on the clipboard while the display stays shortened — copying a truncated
 * address would send tokens nowhere.
 */
function CopyableAddress({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="inline-flex max-w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left font-mono text-secondary text-xs transition-colors hover:bg-fill-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
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

/** Lamports as SOL, to three places — enough to read a rent figure. */
function formatLamports(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").slice(0, 3);
  return `${whole}.${fraction}`;
}

/**
 * One transaction, linked to an explorer.
 *
 * A signature is not something anybody reads — its only use is following it, so
 * it renders as a link rather than as forty-four characters of base58 the way
 * the addresses do.
 */
function TransactionLink({
  signature,
  label,
  cluster,
}: {
  signature: string;
  label: string;
  cluster: SolanaCluster;
}) {
  return (
    <div>
      <dt className="text-tertiary text-xs">{label}</dt>
      <dd className="mt-0.5">
        <a
          className="inline-flex items-center gap-1 text-primary text-xs underline underline-offset-2"
          href={explorerTxUrl(signature, cluster)}
          rel="noreferrer noopener"
          target="_blank"
        >
          <span className="font-mono">{`${signature.slice(0, 8)}…${signature.slice(-8)}`}</span>
          <ExternalLinkIcon aria-hidden className="h-3 w-3 shrink-0" />
        </a>
      </dd>
    </div>
  );
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
  closed: boolean
): { Icon: LucideIcon; tone: string; key: MessageKey } {
  if (closed) {
    return {
      Icon: CircleCheckIcon,
      tone: "text-success",
      key: "DashboardMarkets.dvp.legDelivered",
    };
  }
  if (leg.funding?.frozen) {
    return { Icon: SnowflakeIcon, tone: "text-warning", key: "DashboardMarkets.dvp.legFrozen" };
  }
  if (leg.funding?.surplus) {
    return {
      Icon: TriangleAlertIcon,
      tone: "text-warning",
      key: "DashboardMarkets.dvp.legOverFunded",
    };
  }
  if (leg.funding?.funded) {
    return { Icon: CircleCheckIcon, tone: "text-success", key: "DashboardMarkets.dvp.legFunded" };
  }
  return { Icon: ClockIcon, tone: "text-tertiary", key: "DashboardMarkets.dvp.legAwaiting" };
}

/**
 * Which words the exchange band uses for each side.
 *
 * Past tense once the trade is closed, on ALL shapes. The principal labels
 * already did this and the agent ones did not, so a settled agent trade read
 * "First party delivers" about a delivery that finished minutes ago.
 *
 * A bilateral trade is two of the caller's own legs going the other way, so
 * "you deliver" / "you receive" has no single referent — the party words are
 * the honest ones there.
 */
function exchangeBandLabelKeys(
  kind: DvpTradeKind,
  closed: boolean
): { given: MessageKey; taken: MessageKey } {
  if (kind === "principal") {
    return closed
      ? { given: "DashboardMarkets.dvp.youDelivered", taken: "DashboardMarkets.dvp.youReceived" }
      : { given: "DashboardMarkets.dvp.youDeliver", taken: "DashboardMarkets.dvp.youReceive" };
  }
  return closed
    ? {
        given: "DashboardMarkets.dvp.summaryPartyADelivered",
        taken: "DashboardMarkets.dvp.summaryPartyBDelivered",
      }
    : {
        given: "DashboardMarkets.dvp.summaryPartyADelivers",
        taken: "DashboardMarkets.dvp.summaryPartyBDelivers",
      };
}

function ExchangeBand({ trade, closed }: { trade: DvpTrade; closed: boolean }) {
  const t = useTranslations();
  // A principal trade delivers from the one custodied side. On an agent or
  // bilateral trade the band reads as the swap between the two parties.
  const css = custodiedSidesOf(trade);
  const custodied = css.length === 1 ? css[0] : null;
  const given = custodied === "b" ? trade.legs.b : trade.legs.a;
  const taken = custodied === "b" ? trade.legs.a : trade.legs.b;
  const { given: givenKey, taken: takenKey } = exchangeBandLabelKeys(trade.kind, closed);
  const givenLabel = t(givenKey);
  const takenLabel = t(takenKey);

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-xl border border-border-subtle bg-surface-sunken px-4 py-3">
      <span className="flex items-center gap-2">
        <span className="text-tertiary text-xs">{givenLabel}</span>
        <span className="font-medium text-primary text-sm tabular-nums">
          {formatLegAmount(given.amount, given.decimals)}
          {given.symbol ? ` ${given.symbol}` : ""}
        </span>
      </span>
      <ArrowLeftRightIcon aria-hidden className="h-4 w-4 shrink-0 text-tertiary" />
      <span className="flex items-center gap-2">
        <span className="text-tertiary text-xs">{takenLabel}</span>
        <span className="font-medium text-primary text-sm tabular-nums">
          {formatLegAmount(taken.amount, taken.decimals)}
          {taken.symbol ? ` ${taken.symbol}` : ""}
        </span>
      </span>
    </div>
  );
}

/** One leg: what it owes, what the escrow holds, and where to pay it. */
function LegCard({
  leg,
  title,
  holder,
  action,
  closed,
  cluster,
}: {
  leg: DvpTradeLeg;
  title: string;
  holder: string;
  action?: ReactNode;
  /**
   * The trade is over and this escrow no longer exists on chain.
   *
   * Everything about paying into it has to go: the address stays in the record
   * after the account is closed, and a page still captioned "send exactly the
   * target amount here" is instructing someone to transfer tokens into a closed
   * account, where they are simply gone.
   */
  closed: boolean;
  cluster: SolanaCluster;
}) {
  const t = useTranslations();
  const ratio = legFundingRatio(leg);
  const status = legStatus(leg, closed);

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-4">
      {/* Centred, not baseline-aligned. A flex row takes its baseline from its
          first flex item, and this heading's first item is an SVG — whose
          baseline is its bottom edge. Aligning the row on that pushed the icon
          and the title up off the line they share with the holder beside them,
          which is what made the status icon look hung above its own heading. */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 font-medium text-primary text-sm">
          <status.Icon aria-hidden className={cn("h-4 w-4 shrink-0", status.tone)} />
          {title}
        </h2>
        <span className="text-tertiary text-xs">{holder}</span>
      </div>
      {/* The icon above is decorative; this carries its meaning for everyone. */}
      <p className={cn("mt-1 text-xs", status.tone)}>{t(status.key)}</p>

      {/* One number at full weight; the target is context beneath it. */}
      <p className="mt-3 flex items-baseline gap-1.5 font-semibold text-2xl text-primary">
        <span className="tabular-nums">
          {leg.funding
            ? formatLegAmount(leg.funding.observedAmount, leg.decimals)
            : closed
              ? formatLegAmount(leg.amount, leg.decimals)
              : t("DashboardMarkets.dvp.notObserved")}
        </span>
        {/* A number with no unit is not an amount, and this screen shows two
            different tokens side by side. Falls back to nothing rather than the
            mint address, which would read as a second, longer number. */}
        {leg.symbol ? (
          <span className="font-medium text-base text-secondary">{leg.symbol}</span>
        ) : null}
      </p>
      <p className="mt-0.5 text-tertiary text-xs">
        {closed
          ? t("DashboardMarkets.dvp.deliveredLabel")
          : `${t("DashboardMarkets.dvp.targetLabel")} ${formatLegAmount(leg.amount, leg.decimals)}`}
      </p>

      {closed ? null : ratio === null ? (
        <p className="mt-3 text-tertiary text-xs">{t("DashboardMarkets.dvp.notObservedHint")}</p>
      ) : (
        <div
          aria-label={t("DashboardMarkets.dvp.fundedLabel")}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(ratio * 100)}
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-fill-subtle"
          role="progressbar"
        >
          <div
            className={cn("h-full rounded-full", leg.funding?.funded ? "bg-success" : "bg-info")}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
      )}

      {closed ? null : (
        <>
          <dl className="mt-4 space-y-2 border-border-subtle border-t pt-3">
            <div>
              <dt className="text-tertiary text-xs">{t("DashboardMarkets.dvp.escrowLabel")}</dt>
              <dd className="mt-0.5">
                <CopyableAddress
                  address={leg.escrow}
                  label={t("DashboardMarkets.dvp.escrowLabel")}
                />
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-tertiary text-[11px] leading-relaxed">
            {t("DashboardMarkets.dvp.escrowHint")}
          </p>
        </>
      )}
      {leg.fundingSignature ? (
        <div className="mt-3 border-border-subtle border-t pt-3">
          <TransactionLink
            cluster={cluster}
            label={t("DashboardMarkets.dvp.txFunding")}
            signature={leg.fundingSignature}
          />
        </div>
      ) : null}
      {action ? <div className="mt-3 border-border-subtle border-t pt-3">{action}</div> : null}
    </section>
  );
}

/**
 * One account this page explains: its address, what it is for, and a way out to
 * the explorer.
 *
 * Both of the accounts above are ones SDP created and neither is one a reader
 * has seen before, so an address with a bare label is not an explanation. The
 * settlement authority in particular is minted silently on a project's first
 * trade, holds the only key that can close one, and has to hold SOL to do it.
 */
function ExplorerAddressField({
  address,
  cluster,
  hint,
  label,
}: {
  address: string;
  cluster: SolanaCluster;
  hint: string;
  label: string;
}) {
  const t = useTranslations();
  return (
    <div>
      <dt className="text-tertiary text-xs">{label}</dt>
      <dd className="mt-0.5">
        <CopyableAddress address={address} label={label} />
      </dd>
      <p className="mt-1 text-tertiary text-[11px] leading-relaxed">
        {hint}{" "}
        <a
          className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
          href={explorerAddressUrl(address, cluster)}
          rel="noreferrer noopener"
          target="_blank"
        >
          {t("DashboardMarkets.dvp.viewOnExplorer")}
          <ExternalLinkIcon aria-hidden className="h-3 w-3" />
        </a>
      </p>
    </div>
  );
}

/** One side of the trade and who it is, per the API's classification. */
function PartySectionRow({
  cluster,
  party,
  title,
}: {
  cluster: SolanaCluster;
  party: DvpPartyRef;
  title: string;
}) {
  const t = useTranslations();
  return (
    <div>
      <dt className="flex items-center gap-2 text-tertiary text-xs">
        {title}
        {party.custodied ? (
          <Badge variant="outline">{t("DashboardMarkets.dvp.partyYours")}</Badge>
        ) : null}
      </dt>
      <dd className="mt-0.5">
        <CopyableAddress address={party.address} label={title} />
      </dd>
      {/* A registered counterparty is a link, never plain text: its page holds
          the KYC record the trade was created against. */}
      {party.counterparty ? (
        <p className="mt-1 text-tertiary text-[11px] leading-relaxed">
          <EntityLink
            href={`/dashboard/payments/counterparty/${encodeURIComponent(party.counterparty.id)}`}
          >
            {party.counterparty.label}
          </EntityLink>
        </p>
      ) : (
        <p className="mt-1 text-tertiary text-[11px] leading-relaxed">
          <a
            className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
            href={explorerAddressUrl(party.address, cluster)}
            rel="noreferrer noopener"
            target="_blank"
          >
            {t("DashboardMarkets.dvp.viewOnExplorer")}
            <ExternalLinkIcon aria-hidden className="h-3 w-3" />
          </a>
        </p>
      )}
    </div>
  );
}

/**
 * Who the trade is WITH.
 *
 * This page carried four addresses, both escrows, the settlement authority and
 * your own wallet, and not the one fact that identifies the trade commercially.
 * Both parties are always listed, in the order the legs are captioned in, and
 * each is rendered for how the API classifies it.
 */
function PartiesSection({ cluster, trade }: { cluster: SolanaCluster; trade: DvpTrade }) {
  const t = useTranslations();
  return (
    <dl className="mt-3 grid gap-3 border-border-subtle border-t pt-3 sm:grid-cols-2">
      <PartySectionRow
        cluster={cluster}
        party={trade.legs.a.party}
        title={t("DashboardMarkets.dvp.legPartyA")}
      />
      <PartySectionRow
        cluster={cluster}
        party={trade.legs.b.party}
        title={t("DashboardMarkets.dvp.legPartyB")}
      />
    </dl>
  );
}

function KindBadge({ kind }: { kind: DvpTradeKind }) {
  const t = useTranslations();
  return <Badge variant="outline">{t(KIND_BADGE_KEY[kind])}</Badge>;
}

function TradeSummary({ cluster, trade }: { cluster: SolanaCluster; trade: DvpTrade }) {
  const t = useTranslations();

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex flex-wrap items-center gap-2">
          <DvpStatusBadge status={trade.status} />
          <KindBadge kind={trade.kind} />
        </span>
        <span className="text-tertiary text-xs">
          {trade.observedAt
            ? t("DashboardMarkets.dvp.observedAt", {
                when: formatTimestamp(trade.observedAt, t),
              })
            : t("DashboardMarkets.dvp.neverObserved")}
        </span>
      </div>
      <p className="mt-2 text-tertiary text-[11px] leading-relaxed">
        {t("DashboardMarkets.dvp.observedHint")}
      </p>
      <dl className="mt-4 grid gap-3 border-border-subtle border-t pt-3 sm:grid-cols-2">
        {/* Both of these are accounts SDP created, and neither is one a
            reader has seen before. An address with a bare label is not an
            explanation — the settlement authority in particular is minted
            silently on a project's first trade, holds the only key that can
            close one, and has to hold SOL to do it. */}
        <ExplorerAddressField
          address={trade.swapDvp}
          cluster={cluster}
          hint={t("DashboardMarkets.dvp.onChainAddressHint")}
          label={t("DashboardMarkets.dvp.onChainAddress")}
        />
        <ExplorerAddressField
          address={trade.settlementAuthority}
          cluster={cluster}
          hint={t("DashboardMarkets.dvp.settlementAuthorityHint")}
          label={t("DashboardMarkets.dvp.settlementAuthority")}
        />
      </dl>

      <PartiesSection cluster={cluster} trade={trade} />

      {/* Every transaction this trade produced, in the order it happened.
          Funding is per leg: each leg's signature sits with the escrow it
          funded, and the close is the one that matters and was the one not
          recorded. */}
      {trade.createSignature || trade.closeSignature ? (
        <dl className="mt-3 grid gap-3 border-border-subtle border-t pt-3 sm:grid-cols-2">
          {trade.createSignature ? (
            <TransactionLink
              cluster={cluster}
              label={t("DashboardMarkets.dvp.txCreate")}
              signature={trade.createSignature}
            />
          ) : null}
          {trade.closeSignature ? (
            <TransactionLink
              cluster={cluster}
              label={t("DashboardMarkets.dvp.txClose")}
              signature={trade.closeSignature}
            />
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}

/**
 * Everything wrong with a trade that is worth saying before somebody acts.
 *
 * Its own component because these are three independent conditions that share
 * only a position on the page, and holding them inline meant the workspace's
 * control flow was mostly this. Each decides for itself whether it applies.
 */
function TradeWarnings({ closed, trade }: { closed: boolean; trade: DvpTrade }) {
  const t = useTranslations();
  const frozen = frozenLegs(trade);
  const overFunded = overFundedLegs(trade);
  const readiness = trade.settlementReadiness;
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

      {/* Before the button, not after the failure. The authority is minted
          empty and pays the fee and the account rent for every close, so the
          first settle in a project failed in simulation with an error that
          named neither the account nor the amount. Shown only while the trade
          can still be closed — on a settled one it is history. */}
      {!closed && readiness && !readiness.funded ? (
        <Callout live title={t("DashboardMarkets.dvp.authorityUnfundedTitle")} variant="warning">
          {t("DashboardMarkets.dvp.authorityUnfundedBody", {
            address: readiness.address,
            sol: formatLamports(BigInt(readiness.required) - BigInt(readiness.balance)),
          })}
        </Callout>
      ) : null}
    </>
  );
}

/**
 * One leg's holder caption, by how the API classifies its party.
 *
 * A custodied leg is the caller's own; a registered counterparty is named; an
 * external address is a party of the trade.
 */
function holderLabel(
  t: ReturnType<typeof useTranslations>,
  side: DvpTradeSide,
  leg: DvpTradeLeg
): string {
  if (leg.party.custodied) {
    return t("DashboardMarkets.dvp.legYours");
  }
  if (leg.party.counterparty) {
    return leg.party.counterparty.label;
  }
  return t(side === "a" ? "DashboardMarkets.dvp.legPartyA" : "DashboardMarkets.dvp.legPartyB");
}

/**
 * The two legs, custodied first.
 *
 * Ordered rather than written twice. A principal trade leads with the caller's
 * leg; an agent trade keeps the trade's own A-then-B order; a bilateral trade
 * has two custodied legs and keeps A-then-B, which is the order the parties
 * were named in.
 */
function LegCards({
  action,
  closed,
  trade,
  cluster,
}: {
  /** Per-side funding action, keyed by the side that may fund. */
  action: Partial<Record<DvpTradeSide, ReactNode>>;
  closed: boolean;
  trade: DvpTrade;
  cluster: SolanaCluster;
}) {
  const t = useTranslations();

  const cardA = (
    <LegCard
      action={action.a}
      closed={closed}
      cluster={cluster}
      holder={holderLabel(t, "a", trade.legs.a)}
      key="a"
      leg={trade.legs.a}
      title={t("DashboardMarkets.dvp.legA")}
    />
  );
  const cardB = (
    <LegCard
      action={action.b}
      closed={closed}
      cluster={cluster}
      holder={holderLabel(t, "b", trade.legs.b)}
      key="b"
      leg={trade.legs.b}
      title={t("DashboardMarkets.dvp.legB")}
    />
  );

  // Your leg first, whichever it is. The exchange band above already reads as
  // what you give then what you get, so fixed A-then-B order made the band and
  // the cards under it run opposite ways on a trade where the caller holds leg
  // B. With no custodied leg (agent) or both custodied (bilateral) the trade's
  // own A-then-B order stays.
  const custodiedA = trade.legs.a.party.custodied;
  const custodiedB = trade.legs.b.party.custodied;
  if (custodiedB && !custodiedA) {
    return [cardB, cardA];
  }
  return [cardA, cardB];
}

/**
 * Whether the caller may fund a leg right now.
 *
 * The API says which sides are the caller's via `custodied`; beyond that the
 * escrow has to still be payable: the trade must not be over, the leg must not
 * already hold its target, and a frozen escrow bounces transfers.
 */
function canFundLeg(leg: DvpTradeLeg, status: DvpTrade["status"]): boolean {
  const fundableStatus = status === "created" || status === "partially_funded";
  return leg.party.custodied && fundableStatus && !leg.funding?.funded && !leg.funding?.frozen;
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
  const t = useTranslations();
  const { act, awaitingApproval, error, pending } = useDvpTradeActions(trade.id);
  const partyView = isDvpPartyView(trade);

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
        <p className="text-tertiary text-[11px] leading-relaxed">
          {t("DashboardMarkets.dvp.fundHint")}
        </p>
      </div>
    ) : undefined;

  return (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <div className="mx-auto flex w-full max-w-[63rem] flex-col gap-6">
        <TradeSummary cluster={cluster} trade={trade} />

        {/* Whose move it is. The badge above says what state the trade is in;
            it does not say what to do about it. */}
        <DvpNextStep trade={trade} />

        <TradeWarnings closed={tradeClosed} trade={trade} />

        <ExchangeBand closed={tradeClosed} trade={trade} />

        <div className="grid gap-4 md:grid-cols-2">
          {/* Your leg first, whichever it is. These were fixed in A-then-B
              order while the exchange band directly above already reads as
              what you give and then what you get — so on a trade where the
              caller holds leg B, the band and the two cards under it ran
              opposite ways. Same ordering as the create form, for the same
              reason. */}
          <LegCards
            action={{ a: fundActionFor("a"), b: fundActionFor("b") }}
            closed={tradeClosed}
            cluster={cluster}
            trade={trade}
          />
        </div>

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
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
