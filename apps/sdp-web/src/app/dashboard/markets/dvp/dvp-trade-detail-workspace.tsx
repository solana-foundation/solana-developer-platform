"use client";

import { CheckIcon, CopyIcon, SnowflakeIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { formatTimestamp, shortenAddress } from "../../payments/payments-overview.utils";
import { DvpCloseActions } from "./dvp-close-actions";
import { DvpNextStep } from "./dvp-next-step";
import { DvpStatusBadge } from "./dvp-status";
import {
  type DvpTrade,
  type DvpTradeLeg,
  frozenLegs,
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
      className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-xs text-secondary transition-colors hover:bg-fill-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
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
      <span className="truncate">{shortenAddress(address)}</span>
      {copied ? (
        <CheckIcon aria-hidden className="h-3 w-3 shrink-0 text-success" />
      ) : (
        <CopyIcon aria-hidden className="h-3 w-3 shrink-0" />
      )}
      <span className="sr-only">{label}</span>
    </button>
  );
}

/** One leg: what it owes, what the escrow holds, and where to pay it. */
function LegCard({
  leg,
  title,
  holder,
  action,
}: {
  leg: DvpTradeLeg;
  title: string;
  holder: string;
  action?: ReactNode;
}) {
  const t = useTranslations();
  const ratio = legFundingRatio(leg);

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium text-primary text-sm">{title}</h2>
        <span className="text-tertiary text-xs">{holder}</span>
      </div>

      {/* One number at full weight; the target is context beneath it. */}
      <p className="mt-3 font-semibold text-2xl text-primary tabular-nums">
        {leg.funding ? leg.funding.observedAmount : t("DashboardMarkets.dvp.notObserved")}
      </p>
      <p className="mt-0.5 text-tertiary text-xs">
        {t("DashboardMarkets.dvp.targetLabel")} {leg.amount}
      </p>

      {ratio === null ? (
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

      <dl className="mt-4 space-y-2 border-border-subtle border-t pt-3">
        <div>
          <dt className="text-tertiary text-xs">{t("DashboardMarkets.dvp.escrowLabel")}</dt>
          <dd className="mt-0.5">
            <CopyableAddress address={leg.escrow} label={t("DashboardMarkets.dvp.escrowLabel")} />
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-tertiary text-[11px] leading-relaxed">
        {t("DashboardMarkets.dvp.escrowHint")}
      </p>
      {action ? <div className="mt-3 border-border-subtle border-t pt-3">{action}</div> : null}
    </section>
  );
}

export function DvpTradeDetailWorkspace({ trade }: { trade: DvpTrade }) {
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
            <div>
              <dt className="text-tertiary text-xs">{t("DashboardMarkets.dvp.onChainAddress")}</dt>
              <dd className="mt-0.5">
                <CopyableAddress
                  address={trade.swapDvp}
                  label={t("DashboardMarkets.dvp.onChainAddress")}
                />
              </dd>
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
            </div>
          </dl>
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

        <div className="grid gap-4 md:grid-cols-2">
          <LegCard
            action={sdpLegIsA ? fundAction : undefined}
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
