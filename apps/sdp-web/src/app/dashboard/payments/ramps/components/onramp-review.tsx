"use client";

import { CUSTODY_PROVIDER_CATALOG_BY_ID, type PaymentRampEstimate } from "@sdp/types";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { type ReactNode, useEffect, useMemo, useState } from "react";
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

/** The chosen provider's estimate, or null while none is chosen or it gave no figures. */
function useChosenProviderEstimate(wizard: OnrampWizard): PaymentRampEstimate | null {
  const { fields, selectedRampPair } = wizard;
  const { estimatesByProvider } = useRampEstimate({
    direction: "onramp",
    selectedPair: selectedRampPair,
    amount: fields.amount,
    enabled: fields.provider !== null,
  });
  const estimate = fields.provider === null ? undefined : estimatesByProvider.get(fields.provider);
  return estimate?.status === "ok" ? estimate.estimate : null;
}

/** Who the deposit comes from, with the kind of contact beside the name. */
function CounterpartyRow({ counterparty }: { counterparty: OnrampWizard["selectedCounterparty"] }) {
  const t = useTranslations();
  return (
    <ReviewRow
      label={t("DashboardPayments.ramps.reviewFrom")}
      value={counterparty?.displayName ?? "—"}
      aside={
        counterparty ? t(`DashboardPayments.counterparty.${counterparty.entityType}`) : undefined
      }
    />
  );
}

/**
 * The provider's figures: its fee and that fee's share of the amount, what the wallet receives,
 * and the rate. Without an estimate the fee is a dash and the amount waits for the quote.
 */
function EstimateRows({
  estimate,
  amount,
  fiat,
  asset,
}: {
  estimate: PaymentRampEstimate | null;
  amount: string;
  fiat: string;
  asset: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const numericAmount = Number(amount);
  // Built once per locale: a formatter is slow to construct and the review re-renders each tick.
  const percentFormat = useMemo(
    () => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }),
    [locale]
  );
  const feeShare =
    estimate && Number.isFinite(numericAmount) && numericAmount > 0
      ? percentFormat.format(Number(estimate.fees.total) / numericAmount)
      : null;

  return (
    <>
      <ReviewRow
        label={t("DashboardPayments.ramps.providerFee")}
        value={
          estimate
            ? `${formatDecimalAmount(estimate.fees.total, locale)} ${estimate.fees.currency}`
            : "—"
        }
        aside={feeShare ? t("DashboardPayments.ramps.feeShare", { share: feeShare }) : undefined}
      />
      <ReviewRow
        label={t("DashboardPayments.ramps.walletReceives")}
        value={
          estimate
            ? `${formatDecimalAmount(estimate.cryptoAmount, locale)} ${asset}`
            : t("DashboardPayments.ramps.rateKnownAtQuote")
        }
      />
      {estimate ? (
        <ReviewRow
          label={t("DashboardPayments.manualInstructions.exchangeRate")}
          value={`1 ${fiat} = ${estimate.exchangeRate} ${asset}`}
          aside={t("DashboardPayments.ramps.estimateConfirmedNext")}
        />
      ) : null}
    </>
  );
}

/** The wallet the deposit lands in, with its custody provider beside the name. */
function WalletRow({ wallet }: { wallet: OnrampWizard["selectedWallet"] }) {
  const t = useTranslations();
  const walletProvider = wallet?.provider
    ? CUSTODY_PROVIDER_CATALOG_BY_ID[wallet.provider].label
    : undefined;
  return (
    <ReviewRow
      label={t("DashboardPayments.ramps.into")}
      value={wallet?.label ?? "—"}
      aside={walletProvider}
    />
  );
}

/** How long the estimate holds; nothing when the provider's estimate carries no expiry. */
function EstimateExpiryRow({ expiresAt, now }: { expiresAt: string | undefined; now: number }) {
  const t = useTranslations();
  const remaining = expiresAt ? formatRampQuoteTimeRemaining(expiresAt, now, t) : null;
  if (!remaining) {
    return null;
  }
  return (
    <ReviewRow
      label={t("DashboardPayments.ramps.estimateHoldsFor")}
      value={remaining}
      aside={t("DashboardPayments.ramps.thenItExpires")}
    />
  );
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
  const ok = useChosenProviderEstimate(wizard);
  const now = useSecondsTick(ok?.expiresAt !== undefined);
  const fiat = selectedRampPair.fiatCurrency.toUpperCase();
  const asset = getCryptoRailAssetLabel(selectedRampPair.assetRail);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h3 className="text-body font-medium text-primary">
          {t("DashboardPayments.ramps.preflight")}
        </h3>
        <dl className="divide-y divide-border-subtle">
          <CounterpartyRow counterparty={selectedCounterparty} />
          <ReviewRow
            label={t("DashboardPayments.ramps.provider")}
            value={fields.provider ? getRampProviderLabel(fields.provider) : "—"}
          />
          <ReviewRow
            label={t("DashboardPayments.ramps.youPay")}
            value={`${formatDecimalAmount(fields.amount, locale)} ${fiat}`}
          />
          <EstimateRows estimate={ok} amount={fields.amount} fiat={fiat} asset={asset} />
          <WalletRow wallet={selectedWallet} />
          <EstimateExpiryRow expiresAt={ok?.expiresAt} now={now} />
        </dl>
      </section>
      <Callout variant="danger" title={t("DashboardPayments.ramps.cannotBeUndone")}>
        {t("DashboardPayments.ramps.cannotBeUndoneBody")}
      </Callout>
    </div>
  );
}
