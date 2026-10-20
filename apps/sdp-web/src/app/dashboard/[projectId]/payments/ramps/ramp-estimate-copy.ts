import { compareDecimalAmounts, isDecimalString } from "@sdp/solana/amount";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { PaymentRampEstimate, RampProviderEstimateResult } from "@sdp/types/payments";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/**
 * An estimate figure: two places at least so money reads as money (the legacy
 * cards show none), up to six for dust.
 */
export function formatEstimateFigure(
  value: string,
  locale: string,
  minimumFractionDigits = 2
): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits,
    maximumFractionDigits: 6,
  }).format(parsed);
}

/**
 * "Minimum is 19.92405 USDC" when the provider takes no such amount for the
 * pair, in the currency the amount was given in; null for any other answer.
 */
export function estimateLimitCopy(
  t: Translate,
  estimate: RampProviderEstimateResult | undefined
): string | null {
  if (estimate?.status !== "error" || !("limit" in estimate)) return null;
  return t(
    estimate.reason === "amount_below_minimum"
      ? "DashboardPayments.ramps.providerReasons.minimumAmount"
      : "DashboardPayments.ramps.providerReasons.maximumAmount",
    { amount: estimate.limit.amount, currency: estimate.limit.currency }
  );
}

/** "1 SOL = 109.21 USD": what one unit of the crypto costs, the same way round both directions. */
export function estimateRateCopy(
  t: Translate,
  estimate: PaymentRampEstimate,
  locale: string
): string | null {
  const rate = estimate.exchangeRate;
  if (!isDecimalString(rate) || compareDecimalAmounts(rate, "0") <= 0) return null;
  return t("DashboardPayments.ramps.rateLine", {
    asset: getCryptoRailAssetLabel(estimate.assetRail),
    rate: formatEstimateFigure(rate, locale),
    fiat: estimate.fiatCurrency,
  });
}
