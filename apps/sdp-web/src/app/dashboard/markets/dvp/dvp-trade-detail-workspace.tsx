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
          className="inline-flex items-center gap-1 text-accent text-xs underline-offset-2 hover:underline"
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
  const sdpLegIsA = trade.sdpSide === "a";
  const given = sdpLegIsA ? trade.legs.a : trade.legs.b;
  const taken = sdpLegIsA ? trade.legs.b : trade.legs.a;

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-xl border border-border-subtle bg-surface-sunken px-4 py-3">
      <span className="flex items-center gap-2">
        <span className="text-tertiary text-xs">
          {closed ? t("DashboardMarkets.dvp.youDelivered") : t("DashboardMarkets.dvp.youDeliver")}
        </span>
        <span className="font-medium text-primary text-sm tabular-nums">
          {formatLegAmount(given.amount, given.decimals)}
          {given.symbol ? ` ${given.symbol}` : ""}
        </span>
      </span>
      <ArrowLeftRightIcon aria-hidden className="h-4 w-4 shrink-0 text-tertiary" />
      <span className="flex items-center gap-2">
        <span className="text-tertiary text-xs">
          {closed ? t("DashboardMarkets.dvp.youReceived") : t("DashboardMarkets.dvp.youReceive")}
        </span>
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
      <div className="flex items-baseline justify-between gap-3">
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

  const overFunded = overFundedLegs(trade);
  const frozen = frozenLegs(trade);
  const sdpLegIsA = trade.sdpSide === "a";

  // Only SDP's own leg is fundable from here. The counterparty funds theirs
  // with an ordinary transfer to the escrow — making that a button would mean
  // spending their wallet, which is the whole thing a DvP trade prevents.
  const sdpLeg = sdpLegIsA ? trade.legs.a : trade.legs.b;
  const canFund =
    (trade.status === "created" || trade.status === "partially_funded") &&
    !sdpLeg.funding?.funded &&
    !sdpLeg.funding?.frozen;

  const fundAction = canFund ? (
    <div className="flex flex-col gap-2">
      {/* Clicked, not held. Funding moves your leg into the trade's own escrow,
          which is a step forward rather than something to walk back; hold is
          reserved for destroying something (HOO-1230). */}
      <Button
        className="self-start"
        disabled={pending !== null}
        onClick={() => act("fund")}
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
                  className="inline-flex items-center gap-0.5 text-accent underline-offset-2 hover:underline"
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
              <dt className="text-tertiary text-xs">
                {t("DashboardMarkets.dvp.settlementAuthority")}
              </dt>
              <dd className="mt-0.5">
                <CopyableAddress
                  address={trade.settlementAuthority}
                  label={t("DashboardMarkets.dvp.settlementAuthority")}
                />
              </dd>
              <p className="mt-1 text-tertiary text-[11px] leading-relaxed">
                {t("DashboardMarkets.dvp.settlementAuthorityHint")}{" "}
                <a
                  className="inline-flex items-center gap-0.5 text-accent underline-offset-2 hover:underline"
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
          {trade.sdpWallet ? (
            <dl className="mt-3 border-border-subtle border-t pt-3">
              <div>
                <dt className="text-tertiary text-xs">
                  {t("DashboardMarkets.dvp.sdpWalletLabel")}
                  {trade.sdpWallet.label ? ` · ${trade.sdpWallet.label}` : ""}
                </dt>
                <dd className="mt-0.5">
                  <CopyableAddress
                    address={trade.sdpWallet.address}
                    label={t("DashboardMarkets.dvp.sdpWalletLabel")}
                  />
                </dd>
                <p className="mt-1 text-tertiary text-[11px] leading-relaxed">
                  {t("DashboardMarkets.dvp.sdpWalletHint")}
                </p>
              </div>
            </dl>
          ) : null}

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

        {/* Whose move it is. The badge above says what state the trade is in;
            it does not say what to do about it. */}
        <DvpNextStep trade={trade} />

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

        <ExchangeBand closed={tradeClosed} trade={trade} />

        <div className="grid gap-4 md:grid-cols-2">
          <LegCard
            action={sdpLegIsA ? fundAction : undefined}
            closed={tradeClosed}
            holder={
              sdpLegIsA
                ? t("DashboardMarkets.dvp.legSdp")
                : t("DashboardMarkets.dvp.legCounterparty")
            }
            leg={trade.legs.a}
            title={t("DashboardMarkets.dvp.legA")}
          />
          <LegCard
            action={sdpLegIsA ? undefined : fundAction}
            closed={tradeClosed}
            holder={
              sdpLegIsA
                ? t("DashboardMarkets.dvp.legCounterparty")
                : t("DashboardMarkets.dvp.legSdp")
            }
            leg={trade.legs.b}
            title={t("DashboardMarkets.dvp.legB")}
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

        <DvpCloseActions onAct={act} pending={pending} trade={trade} />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
