import { compareDecimalAmounts, isDecimalString } from "@sdp/solana/amount";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type {
  PaymentRampEstimate,
  PaymentRampEstimateFees,
  RampProviderEstimateResult,
} from "@sdp/types/payments";
import { formatDecimalAmount } from "@/app/dashboard/[projectId]/payments/payments-presentation";
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
  if (!isPositiveDecimal(rate)) return null;
  return t("DashboardPayments.ramps.rateLine", {
    asset: getCryptoRailAssetLabel(estimate.assetRail),
    rate: formatEstimateFigure(rate, locale),
    fiat: estimate.fiatCurrency,
  });
}

/**
 * The fee beside an estimate: the provider's and the network's apart when they
 * are charged in different currencies, else the total.
 */
export function estimateFeeCopy(
  t: Translate,
  fees: PaymentRampEstimateFees,
  locale: string,
  minimumFractionDigits = 2
): string {
  const { provider, network, providerCurrency, networkCurrency } = fees;
  if (
    provider !== undefined &&
    isPositiveDecimal(provider) &&
    network !== undefined &&
    isPositiveDecimal(network) &&
    providerCurrency &&
    networkCurrency &&
    providerCurrency !== networkCurrency
  ) {
    return t("DashboardPayments.ramps.fees", {
      providerFee: formatEstimateFigure(provider, locale, minimumFractionDigits),
      providerCurrency,
      networkFee: formatEstimateFigure(network, locale, minimumFractionDigits),
      networkCurrency,
    });
  }
  if (isDecimalString(fees.total) && compareDecimalAmounts(fees.total, "0") === 0) {
    return t("DashboardPayments.ramps.noFees");
  }
  return t("DashboardPayments.ramps.fee", {
    amount: formatEstimateFigure(fees.total, locale, minimumFractionDigits),
    currency: fees.currency,
  });
}

/**
 * "You pay" on the on-ramp review: the provider's total and how its fees sit in
 * it. Stripe adds them on top of the amount; MoonPay's widget takes them out of
 * it. Without a total the amount typed stands alone.
 */
export function youPayCopy(
  t: Translate,
  {
    estimate,
    amount,
    fiat,
  }: { estimate: PaymentRampEstimate | null; amount: string; fiat: string },
  locale: string
): { value: string; aside: string | undefined } {
  const total = estimate?.totalFiatAmount;
  if (
    estimate === null ||
    total === undefined ||
    !isDecimalString(total) ||
    !isDecimalString(amount)
  ) {
    return { value: `${formatDecimalAmount(amount, locale)} ${fiat}`, aside: undefined };
  }
  const value = `${formatDecimalAmount(total, locale)} ${fiat}`;
  if (compareDecimalAmounts(total, amount) > 0) {
    return {
      value,
      aside: t("DashboardPayments.ramps.youPayPlusFees", {
        amount: `${formatDecimalAmount(amount, locale)} ${fiat}`,
      }),
    };
  }
  return {
    value,
    aside: isPositiveDecimal(estimate.fees.total)
      ? t("DashboardPayments.ramps.youPayFeesIncluded")
      : undefined,
  };
}

function isPositiveDecimal(value: string): boolean {
  return isDecimalString(value) && compareDecimalAmounts(value, "0") > 0;
}
