"use client";

import type { PaymentRampQuote } from "@sdp/types";
import { ArrowDownLeft, CoinsIcon, DollarSignIcon, WalletIcon } from "lucide-react";
import { formatDisplayAmount } from "@/app/dashboard/payments/payments-overview.utils";
import { useTranslations } from "@/i18n/provider";
import { QuoteSummaryField } from "../manual-instructions-quote";

type CoinbaseQuote = Extract<PaymentRampQuote, { provider: "coinbase" }>;

/**
 * Locked order economics shown above the Apple Pay button, mirroring the
 * Lightspark quote-summary grid.
 */
export function CoinbaseQuoteSummary({ quote }: { quote: CoinbaseQuote }) {
  const t = useTranslations();
  const feesIncluded = quote.fees.reduce((total, fee) => total + Number(fee.feeAmount), 0);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <QuoteSummaryField
        icon={<CoinsIcon className="size-4" />}
        label={t("DashboardPayments.manualInstructions.finalAmount")}
        value={formatDisplayAmount(quote.purchaseAmount, quote.purchaseCurrency)}
      />
      <QuoteSummaryField
        icon={<WalletIcon className="size-4" />}
        label={t("DashboardPayments.manualInstructions.depositAmount")}
        value={formatDisplayAmount(quote.paymentTotal, quote.paymentCurrency)}
      />
      <QuoteSummaryField
        icon={<DollarSignIcon className="size-4" />}
        label={t("DashboardPayments.manualInstructions.feesIncluded")}
        value={formatDisplayAmount(String(feesIncluded), quote.paymentCurrency)}
      />
      <QuoteSummaryField
        icon={<ArrowDownLeft className="size-4" />}
        label={t("DashboardPayments.manualInstructions.exchangeRate")}
        value={`1 ${quote.purchaseCurrency} = ${formatDisplayAmount(quote.exchangeRate, quote.paymentCurrency)}`}
      />
    </div>
  );
}
