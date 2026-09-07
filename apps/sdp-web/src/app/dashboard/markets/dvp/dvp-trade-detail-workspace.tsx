"use client";

import type { SolanaCluster } from "@sdp/types";
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
  type DvpTrade,
  type DvpTradeLeg,
  formatLegAmount,
  frozenLegs,
  isDvpAgentTrade,
  isDvpPartyView,
  isDvpTradeClosed,
  legFundingRatio,
  overFundedLegs,
  sdpLegSideOf,
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
 * Which way the value moves, stated once, between the two legs.
 *
 * A DvP trade IS an exchange, and two cards sitting side by side never said so
 * — nothing on the page connected them, or named which direction anything went.
 * This is the one place the page earns its width.
 */
function ExchangeBand({ trade, closed }: { trade: DvpTrade; closed: boolean }) {
  const t = useTranslations();
  const sdpSide = sdpLegSideOf(trade);
  const agent = sdpSide === null;

  // On an agent trade nobody here delivers or receives anything, so the band
  // reads as the swap between the two parties instead of as your own position.
  // Left is always the first party's leg then, because "you" has no referent.
  const given = agent || sdpSide === "a" ? trade.legs.a : trade.legs.b;
  const taken = agent || sdpSide === "a" ? trade.legs.b : trade.legs.a;
  // Past tense once the trade is closed, on both shapes. The principal labels
  // already did this and the agent ones did not, so a settled agent trade read
  // "First party delivers" about a delivery that finished minutes ago.
  const givenLabel = agent
    ? t(
        closed
          ? "DashboardMarkets.dvp.summaryPartyADelivered"
          : "DashboardMarkets.dvp.summaryPartyADelivers"
      )
    : t(closed ? "DashboardMarkets.dvp.youDelivered" : "DashboardMarkets.dvp.youDeliver");
  const takenLabel = agent
    ? t(
        closed
          ? "DashboardMarkets.dvp.summaryPartyBDelivered"
          : "DashboardMarkets.dvp.summaryPartyBDelivers"
      )
    : t(closed ? "DashboardMarkets.dvp.youReceived" : "DashboardMarkets.dvp.youReceive");

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
      {action ? <div className="mt-3 border-border-subtle border-t pt-3">{action}</div> : null}
    </section>
  );
}

/**
 * Everything the trade IS, before anything you can do about it.
 *
 * Extracted because the workspace had grown past three hundred lines and read
 * as one wall: the badge and its reading age, the two accounts SDP created and
 * what each is for, the wallet funding your leg, the counterparty, and every
 * transaction the trade has produced. Those are one answer to one question —
 * what am I looking at — and the rest of the page is a different question.
 */
function TradeSummary({
  cluster,
  counterparty,
  trade,
}: {
  cluster: SolanaCluster;
  /** Null on an agent trade, which has two counterparties and neither is us. */
  counterparty: string | null;
  trade: DvpTrade;
}) {
  const t = useTranslations();
  const agentTrade = isDvpAgentTrade(trade);
  const walletLabelKey = agentTrade
    ? ("DashboardMarkets.dvp.sdpWalletLabelAgent" as const)
    : ("DashboardMarkets.dvp.sdpWalletLabel" as const);

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DvpStatusBadge status={trade.status} />
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
        <div>
          <dt className="text-tertiary text-xs">{t("DashboardMarkets.dvp.onChainAddress")}</dt>
          <dd className="mt-0.5">
            <CopyableAddress
              address={trade.swapDvp}
              label={t("DashboardMarkets.dvp.onChainAddress")}
            />
          </dd>
          <p className="mt-1 text-tertiary text-[11px] leading-relaxed">
            {t("DashboardMarkets.dvp.onChainAddressHint")}{" "}
            <a
              className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
              href={explorerAddressUrl(trade.swapDvp, cluster)}
              rel="noreferrer noopener"
              target="_blank"
            >
              {t("DashboardMarkets.dvp.viewOnExplorer")}
              <ExternalLinkIcon aria-hidden className="h-3 w-3" />
            </a>
          </p>
        </div>
        <div>
          <dt className="text-tertiary text-xs">{t("DashboardMarkets.dvp.settlementAuthority")}</dt>
          <dd className="mt-0.5">
            <CopyableAddress
              address={trade.settlementAuthority}
              label={t("DashboardMarkets.dvp.settlementAuthority")}
            />
          </dd>
          <p className="mt-1 text-tertiary text-[11px] leading-relaxed">
            {t("DashboardMarkets.dvp.settlementAuthorityHint")}{" "}
            <a
              className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
              href={explorerAddressUrl(trade.settlementAuthority, cluster)}
              rel="noreferrer noopener"
              target="_blank"
            >
              {t("DashboardMarkets.dvp.viewOnExplorer")}
              <ExternalLinkIcon aria-hidden className="h-3 w-3" />
            </a>
          </p>
        </div>
      </dl>

      {/* The wallet YOU chose, which the page never showed — so the only
          wallet-shaped address on it was the settlement authority, a system
          account with signing power over the trade. It was read as the
          reader's own, which is exactly the confusion to avoid. */}
      {/* "Funded from" is only true when this wallet delivers a leg. On an
          agent trade it signs the create and pays the fee and the escrow rent
          and nothing else, so the row is titled by what it actually did. This
          one is keyed off `sdpWallet` rather than the side, which is why
          sweeping every `sdpSide` read did not reach it. */}
      {trade.sdpWallet ? (
        <dl className="mt-3 border-border-subtle border-t pt-3">
          <div>
            <dt className="text-tertiary text-xs">
              {t(walletLabelKey)}
              {trade.sdpWallet.label ? ` · ${trade.sdpWallet.label}` : ""}
            </dt>
            <dd className="mt-0.5">
              <CopyableAddress address={trade.sdpWallet.address} label={t(walletLabelKey)} />
            </dd>
            <p className="mt-1 text-tertiary text-[11px] leading-relaxed">
              {t(
                agentTrade
                  ? "DashboardMarkets.dvp.sdpWalletHintAgent"
                  : "DashboardMarkets.dvp.sdpWalletHint"
              )}
            </p>
          </div>
        </dl>
      ) : null}

      {/* Who the trade is WITH. This page carried four addresses — both
          escrows, the settlement authority and your own wallet — and not
          the one fact that identifies the trade commercially. It is also
          the address somebody needs to hand back to the other side to
          confirm they are looking at the same trade, so it is copyable in
          full like the rest. */}
      <dl className="mt-3 border-border-subtle border-t pt-3">
        {counterparty === null ? (
          // Two parties, neither of them us, so there is no single "the other
          // side" to name. Both are listed instead, in the order they were
          // entered, which is the order the legs are captioned in.
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["DashboardMarkets.dvp.legPartyA", trade.legs.a.party],
                ["DashboardMarkets.dvp.legPartyB", trade.legs.b.party],
              ] as const
            ).map(([key, party]) => (
              <div key={key}>
                <dt className="text-tertiary text-xs">{t(key)}</dt>
                <dd className="mt-0.5">
                  <CopyableAddress address={party} label={t(key)} />
                </dd>
                <p className="mt-1 text-tertiary text-[11px] leading-relaxed">
                  <a
                    className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
                    href={explorerAddressUrl(party, cluster)}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {t("DashboardMarkets.dvp.viewOnExplorer")}
                    <ExternalLinkIcon aria-hidden className="h-3 w-3" />
                  </a>
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div>
            <dt className="text-tertiary text-xs">{t("DashboardMarkets.dvp.counterpartyLabel")}</dt>
            <dd className="mt-0.5">
              <CopyableAddress
                address={counterparty}
                label={t("DashboardMarkets.dvp.counterpartyLabel")}
              />
            </dd>
            <p className="mt-1 text-tertiary text-[11px] leading-relaxed">
              {t("DashboardMarkets.dvp.counterpartyHint")}{" "}
              <a
                className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2"
                href={explorerAddressUrl(counterparty, cluster)}
                rel="noreferrer noopener"
                target="_blank"
              >
                {t("DashboardMarkets.dvp.viewOnExplorer")}
                <ExternalLinkIcon aria-hidden className="h-3 w-3" />
              </a>
            </p>
          </div>
        )}
      </dl>

      {/* Every transaction this trade produced, in the order it happened.
          The close is the one that matters and was the one not recorded. */}
      {trade.createSignature || trade.fundingSignature || trade.closeSignature ? (
        <dl className="mt-3 grid gap-3 border-border-subtle border-t pt-3 sm:grid-cols-3">
          {trade.createSignature ? (
            <TransactionLink
              cluster={cluster}
              label={t("DashboardMarkets.dvp.txCreate")}
              signature={trade.createSignature}
            />
          ) : null}
          {trade.fundingSignature ? (
            <TransactionLink
              cluster={cluster}
              label={t("DashboardMarkets.dvp.txFunding")}
              signature={trade.fundingSignature}
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
    (leg) => leg.settlementDestination !== leg.party
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
 * The two legs, yours first.
 *
 * Ordered rather than written twice. The previous version branched on which
 * side was SDP's and then re-tested that same flag inside every prop of both
 * copies, where it is provably constant - the create form's LegCards hit the
 * identical problem and the compiler said so. Holding the cards as values and
 * ordering them keeps one copy of the markup and one decision.
 */
function LegCards({
  action,
  closed,
  trade,
}: {
  action?: ReactNode;
  closed: boolean;
  trade: DvpTrade;
}) {
  const t = useTranslations();
  const sdpSide = sdpLegSideOf(trade);
  const agent = sdpSide === null;

  // Which card carries the action. The author funds the leg it holds; a party
  // reading somebody else's trade funds the leg NAMING them, which on an agent
  // trade is a leg this function would otherwise give no action to at all.
  const actionSide = trade.yourSide ?? sdpSide;

  // On an agent trade both legs belong to other parties, so neither card can be
  // captioned "held by this organization" and neither carries a fund action.
  const holderA = agent
    ? t("DashboardMarkets.dvp.legPartyA")
    : sdpSide === "a"
      ? t("DashboardMarkets.dvp.legSdp")
      : t("DashboardMarkets.dvp.legCounterparty");
  const holderB = agent
    ? t("DashboardMarkets.dvp.legPartyB")
    : sdpSide === "a"
      ? t("DashboardMarkets.dvp.legCounterparty")
      : t("DashboardMarkets.dvp.legSdp");

  const cardA = (
    <LegCard
      action={actionSide === "a" ? action : undefined}
      closed={closed}
      holder={holderA}
      key="a"
      leg={trade.legs.a}
      title={t("DashboardMarkets.dvp.legA")}
    />
  );
  const cardB = (
    <LegCard
      action={actionSide === "b" ? action : undefined}
      closed={closed}
      holder={holderB}
      key="b"
      leg={trade.legs.b}
      title={t("DashboardMarkets.dvp.legB")}
    />
  );

  // Your leg first, whichever it is. The exchange band above already reads as
  // what you give then what you get, so fixed A-then-B order made the band and
  // the cards under it run opposite ways on a trade where SDP holds leg B.
  //
  // An agent trade has no leg of yours to lead with, so it keeps the trade's
  // own A-then-B order, which is the order the parties were named in.
  return agent || sdpSide === "a" ? [cardA, cardB] : [cardB, cardA];
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

  // Null on an agent trade, where this organization delivers neither leg.
  const sdpSide = sdpLegSideOf(trade);

  // Only SDP's own leg is fundable from here. The counterparty funds theirs
  // with an ordinary transfer to the escrow — making that a button would mean
  // spending their wallet, which is the whole thing a DvP trade prevents.
  //
  // On an agent trade there is no own leg, so there is nothing to fund from
  // here at all. This read used to be `sdpSide === "a" ? a : b`, which answered
  // "b" for a trade with no SDP leg and offered to fund a leg we hold no key
  // for. The API refuses it (`services/dvp/fund.ts:119`), so the button led
  // nowhere, but it contradicted the one thing an agent trade means.
  const sdpLeg = sdpSide === null ? null : sdpSide === "a" ? trade.legs.a : trade.legs.b;
  // The other side's address, which is whichever leg is not ours. An agent
  // trade has two counterparties and we are neither, so it has no "other side".
  const counterparty =
    sdpSide === null ? null : sdpSide === "a" ? trade.legs.b.party : trade.legs.a.party;
  // A party reading somebody else's trade funds THEIR leg, through the party
  // endpoint, with their own wallet policy governing it. `sdpSide` describes
  // the author and says nothing about them.
  const partyView = isDvpPartyView(trade);
  const fundableLeg = partyView ? (trade.yourSide === "a" ? trade.legs.a : trade.legs.b) : sdpLeg;
  const canFund =
    fundableLeg !== null &&
    (trade.status === "created" || trade.status === "partially_funded") &&
    !fundableLeg.funding?.funded &&
    !fundableLeg.funding?.frozen;

  const fundAction = canFund ? (
    <div className="flex flex-col gap-2">
      {/* Clicked, not held. Funding moves your leg into the trade's own escrow,
          which is a step forward rather than something to walk back; hold is
          reserved for destroying something (HOO-1230). */}
      <Button
        className="self-start"
        disabled={pending !== null}
        onClick={() => act(partyView ? "fund-as-party" : "fund")}
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
        <TradeSummary cluster={cluster} counterparty={counterparty} trade={trade} />

        {/* Whose move it is. The badge above says what state the trade is in;
            it does not say what to do about it. */}
        <DvpNextStep trade={trade} />

        <TradeWarnings closed={tradeClosed} trade={trade} />

        <ExchangeBand closed={tradeClosed} trade={trade} />

        <div className="grid gap-4 md:grid-cols-2">
          {/* Your leg first, whichever it is. These were fixed in A-then-B
              order while the exchange band directly above already reads as
              what you give and then what you get — so on a trade where SDP
              holds leg B, the band and the two cards under it ran opposite
              ways. Same ordering as the create form, for the same reason. */}
          <LegCards action={fundAction} closed={tradeClosed} trade={trade} />
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
