"use client";

import { CheckIcon, CopyIcon, SnowflakeIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Callout } from "@/components/ui/callout";
import { HoldToConfirmButton } from "@/components/ui/hold-to-confirm-button";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { formatTimestamp, shortenAddress } from "../../payments/payments-overview.utils";
import { DvpStatusBadge } from "./dvp-status";
import {
  canCancelDvpTrade,
  canSettleDvpTrade,
  type DvpTrade,
  type DvpTradeLeg,
  frozenLegs,
  legFundingRatio,
  overFundedLegs,
} from "./dvp-trade";

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
function LegCard({ leg, title, holder }: { leg: DvpTradeLeg; title: string; holder: string }) {
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
        {leg.funding ? leg.funding.observedAmount : "—"}
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
    </section>
  );
}

export function DvpTradeDetailWorkspace({ trade }: { trade: DvpTrade }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState<"settle" | "cancel" | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overFunded = overFundedLegs(trade);
  const frozen = frozenLegs(trade);
  const sdpLegIsA = trade.sdpSide === "a";

  async function close(action: "settle" | "cancel") {
    setPending(action);
    setError(null);
    setAwaitingApproval(false);
    try {
      const response = await fetch(
        `/api/dashboard/markets/dvp/trades/${encodeURIComponent(trade.id)}/${action}`,
        { method: "POST" }
      );
      // 202 is a normal outcome, not a failure: wallet policy is holding the
      // action for approval. Treating it as an error would tell an operator
      // something broke when the platform did exactly what they configured.
      if (response.status === 202) {
        setAwaitingApproval(true);
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(body.error?.message ?? `Request failed (${response.status}).`);
        return;
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setPending(null);
    }
  }

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
            holder={
              sdpLegIsA
                ? t("DashboardMarkets.dvp.legSdp")
                : t("DashboardMarkets.dvp.legCounterparty")
            }
            leg={trade.legs.a}
            title={t("DashboardMarkets.dvp.legA")}
          />
          <LegCard
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

        {canCancelDvpTrade(trade) ? (
          <section className="rounded-2xl border border-border-default bg-surface-raised p-4">
            {/* Each action sits with its own explanation. Both are
                irreversible so both are hold-to-confirm, but only cancel is
                destructive — settling is the outcome the trade exists for, and
                styling the two identically would make the intended path look
                as risky as abandoning the trade. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <HoldToConfirmButton
                  className="self-start"
                  disabled={!canSettleDvpTrade(trade) || pending !== null}
                  label={t("DashboardMarkets.dvp.actionSettle")}
                  onConfirm={() => close("settle")}
                  variant="default"
                />
                <p className="text-secondary text-xs leading-relaxed">
                  {t("DashboardMarkets.dvp.settleHint")}
                </p>
                {!canSettleDvpTrade(trade) ? (
                  <p className="text-tertiary text-xs">{t("DashboardMarkets.dvp.settleBlocked")}</p>
                ) : null}
              </div>
              <div className="flex flex-col gap-2">
                <HoldToConfirmButton
                  className="self-start"
                  disabled={pending !== null}
                  label={t("DashboardMarkets.dvp.actionCancel")}
                  onConfirm={() => close("cancel")}
                />
                <p className="text-secondary text-xs leading-relaxed">
                  {t("DashboardMarkets.dvp.cancelHint")}
                </p>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
