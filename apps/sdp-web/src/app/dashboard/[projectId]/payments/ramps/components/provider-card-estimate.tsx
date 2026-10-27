"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { RampProviderEstimateResult } from "@sdp/types/payments";
import { Loader2Icon } from "lucide-react";
import {
  estimateFeeCopy,
  estimateLimitCopy,
  estimateRateCopy,
  formatEstimateFigure,
} from "@/app/dashboard/[projectId]/payments/ramps/ramp-estimate-copy";
import { useLocale, useTranslations } from "@/i18n/provider";

/**
 * A provider card's estimate: what arrives and the fee, a payout's rate, or
 * why there is none.
 */
export function ProviderCardEstimate({
  estimate,
  estimateLoading,
}: {
  estimate?: RampProviderEstimateResult;
  estimateLoading?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (estimateLoading) {
    return <Loader2Icon className="size-4 shrink-0 animate-spin text-tertiary" />;
  }

  if (estimate?.status === "ok") {
    const { direction, fiatCurrency, assetRail, fiatAmount, cryptoAmount, fees } =
      estimate.estimate;
    const isFiatOut = direction === "offramp";
    const amount = formatEstimateFigure(isFiatOut ? fiatAmount : cryptoAmount, locale);
    const unit = isFiatOut ? fiatCurrency : getCryptoRailAssetLabel(assetRail);
    const feeLabel = estimateFeeCopy(t, fees, locale);
    // A payout is the crypto at the rate, less the fee; without the rate the numbers don't add up.
    const rate = isFiatOut ? estimateRateCopy(t, estimate.estimate, locale) : null;

    return (
      <div className="shrink-0 text-right leading-none">
        <p className="mb-1 text-xs font-medium uppercase tracking-widest text-tertiary">
          {t("DashboardPayments.ramps.estimatedReceived")}
        </p>
        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
          <span className="text-sm leading-none font-semibold text-primary">{`≈ ${amount} ${unit}`}</span>
          <span className="rounded-full bg-fill-subtle px-2 py-0.5 text-xs leading-none font-medium text-tertiary">
            {feeLabel}
          </span>
        </div>
        {rate ? <p className="mt-1 text-xs text-tertiary">{rate}</p> : null}
      </div>
    );
  }

  if (estimate?.status === "unsupported") {
    return (
      <p className="shrink-0 text-sm text-tertiary">
        {t("DashboardPayments.ramps.rateKnownAtQuote")}
      </p>
    );
  }

  if (estimate?.status === "error") {
    return (
      <p className="shrink-0 text-sm text-tertiary">
        {estimateLimitCopy(t, estimate) ?? t("DashboardPayments.ramps.unavailable")}
      </p>
    );
  }

  return null;
}
