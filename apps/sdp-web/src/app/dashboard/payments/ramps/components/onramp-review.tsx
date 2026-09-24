"use client";

import { CUSTODY_PROVIDER_CATALOG_BY_ID } from "@sdp/types";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { type ReactNode, useEffect, useState } from "react";
import { Callout } from "@/components/ui/callout";
import { useLocale, useTranslations } from "@/i18n/provider";
import { getRampProviderLabel } from "@/lib/ramps";
import { formatRampQuoteTimeRemaining } from "../../payments-overview.utils";
import { formatDecimalAmount } from "../../payments-presentation";
import type { OnrampWizard } from "../hooks/use-onramp-wizard";
import { useRampEstimate } from "../hooks/use-ramp-estimate";

function ReviewRow({ label, value, aside }: { label: string; value: ReactNode; aside?: string }) {
  return (
    <div className="grid gap-1 py-3.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-4">
      <dt className="text-body text-secondary">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-body text-primary">{value}</span>
        {aside ? <span className="text-body text-secondary">{aside}</span> : null}
      </dd>
    </div>
  );
}

function useSecondsTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Deposit's review, read from the chosen provider's estimate. The real quote (and the transfer
 * it records) is only created on the next step, so the page says the figures are an estimate
 * and shows a countdown only when the provider's estimate carries an expiry.
 */
export function OnrampReview({ wizard }: { wizard: OnrampWizard }) {
  const t = useTranslations();
  const locale = useLocale();
  const { fields, selectedRampPair, selectedCounterparty, selectedWallet } = wizard;
  const { estimatesByProvider } = useRampEstimate({
    direction: "onramp",
    selectedPair: selectedRampPair,
    amount: fields.amount,
    enabled: fields.provider !== null,
  });
  const estimate = fields.provider === null ? undefined : estimatesByProvider.get(fields.provider);
  const ok = estimate?.status === "ok" ? estimate.estimate : null;
  const now = useSecondsTick(ok?.expiresAt !== undefined);
  const fiat = selectedRampPair.fiatCurrency.toUpperCase();
  const asset = getCryptoRailAssetLabel(selectedRampPair.assetRail);
  const amount = Number(fields.amount);
  const feeShare =
    ok && Number.isFinite(amount) && amount > 0
      ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(
          Number(ok.fees.total) / amount
        )
      : null;
  const walletProvider = selectedWallet?.provider
    ? CUSTODY_PROVIDER_CATALOG_BY_ID[selectedWallet.provider].label
    : undefined;
  const remaining = ok?.expiresAt ? formatRampQuoteTimeRemaining(ok.expiresAt, now, t) : null;

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h3 className="text-body font-medium text-primary">
          {t("DashboardPayments.ramps.preflight")}
        </h3>
        <dl className="divide-y divide-border-subtle">
          <ReviewRow
            label={t("DashboardPayments.ramps.reviewFrom")}
            value={selectedCounterparty?.displayName ?? "—"}
            aside={
              selectedCounterparty
                ? t(`DashboardPayments.counterparty.${selectedCounterparty.entityType}`)
                : undefined
            }
          />
          <ReviewRow
            label={t("DashboardPayments.ramps.provider")}
            value={fields.provider ? getRampProviderLabel(fields.provider) : "—"}
          />
          <ReviewRow
            label={t("DashboardPayments.ramps.youPay")}
            value={`${formatDecimalAmount(fields.amount, locale)} ${fiat}`}
          />
          <ReviewRow
            label={t("DashboardPayments.ramps.providerFee")}
            value={ok ? `${formatDecimalAmount(ok.fees.total, locale)} ${ok.fees.currency}` : "—"}
            aside={
              feeShare ? t("DashboardPayments.ramps.feeShare", { share: feeShare }) : undefined
            }
          />
          <ReviewRow
            label={t("DashboardPayments.ramps.walletReceives")}
            value={
              ok
                ? `${formatDecimalAmount(ok.cryptoAmount, locale)} ${asset}`
                : t("DashboardPayments.ramps.rateKnownAtQuote")
            }
          />
          {ok ? (
            <ReviewRow
              label={t("DashboardPayments.manualInstructions.exchangeRate")}
              value={`1 ${fiat} = ${ok.exchangeRate} ${asset}`}
              aside={t("DashboardPayments.ramps.estimateConfirmedNext")}
            />
          ) : null}
          <ReviewRow
            label={t("DashboardPayments.ramps.into")}
            value={selectedWallet?.label ?? "—"}
            aside={walletProvider}
          />
          {remaining ? (
            <ReviewRow
              label={t("DashboardPayments.ramps.estimateHoldsFor")}
              value={remaining}
              aside={t("DashboardPayments.ramps.thenItExpires")}
            />
          ) : null}
        </dl>
      </section>
      <Callout variant="danger" title={t("DashboardPayments.ramps.cannotBeUndone")}>
        {t("DashboardPayments.ramps.cannotBeUndoneBody")}
      </Callout>
    </div>
  );
}
