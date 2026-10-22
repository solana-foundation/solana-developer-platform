"use client";

import type { TokenMovementAmounts } from "@sdp/types/token-movements";
import { SegmentedControl } from "@sdp/ui/segmented-control";
import type { ReactNode } from "react";
import { formatTokenAmount } from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { AMOUNT_ENTRY_UNITS } from "@/app/dashboard/[projectId]/payments/token-amount-quote.data";
import type { TokenAmountEntry } from "@/app/dashboard/[projectId]/payments/use-token-amount-entry";
import { TokenDisplayAmount } from "@/components/token-display-amount";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";

/**
 * Picks what the amount input holds, for a mint with a display rule only:
 * token units, or what wallets show. Locked while a quote is read, since it
 * changes what gets sent.
 */
export function AmountUnitToggle({ entry }: { entry: TokenAmountEntry }) {
  const t = useTranslations();
  if (!entry.displayEntryAvailable) return null;
  return (
    <SegmentedControl
      ariaLabel={t("DashboardPayments.tokenAmount.enterAs")}
      className="w-fit"
      options={[
        { value: "token", label: t("DashboardPayments.tokenAmount.unitToken") },
        { value: "display", label: t("DashboardPayments.tokenAmount.unitDisplay") },
      ]}
      value={entry.unit}
      onChange={(value) => {
        const unit = AMOUNT_ENTRY_UNITS.find((candidate) => candidate === value);
        if (unit !== undefined) entry.setUnit(unit);
      }}
      disabled={entry.quoteInFlight}
    />
  );
}

/** The side of the movement the amount does not fix: a send's credit, a request's debit. */
function otherSide(amounts: TokenMovementAmounts): {
  amount: string;
  display: string | null;
  label: MessageKey;
  displayLabel: MessageKey;
} {
  switch (amounts.basis) {
    case "debit":
      return {
        amount: amounts.credit,
        display: amounts.display === undefined ? null : amounts.display.credit,
        label: "DashboardPayments.tokenAmount.quoteRecipientReceives",
        displayLabel: "DashboardPayments.tokenAmount.quoteRecipientShows",
      };
    case "credit":
      return {
        amount: amounts.debit,
        display: amounts.display === undefined ? null : amounts.display.debit,
        label: "DashboardPayments.tokenAmount.quotePayerPays",
        displayLabel: "DashboardPayments.tokenAmount.quotePayerShows",
      };
    default: {
      const unreachable: never = amounts.basis;
      throw new Error(`Unknown movement basis: ${String(unreachable)}`);
    }
  }
}

function PreviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-tertiary">{label}</dt>
      <dd className="text-right text-secondary tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * What the quote says the movement moves, in token units: the token amount a
 * display input converts to, the transfer fee, and the other side (what the
 * recipient receives on a send, what the payer pays on a request). The other
 * side's display value follows for a mint with a display rule.
 */
export function TokenAmountQuotePreview({
  entry,
  symbol,
}: {
  entry: TokenAmountEntry;
  symbol: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { quote, terms } = entry;
  if (entry.quoteError !== null) {
    return <p className="text-meta text-error">{entry.quoteError}</p>;
  }
  if (quote === null || terms === null) {
    return entry.quoteInFlight ? (
      <p className="text-meta text-tertiary">{t("DashboardPayments.tokenAmount.quoting")}</p>
    ) : null;
  }
  const amount = (value: string) => `${formatTokenAmount(value, locale)} ${symbol}`;
  const { amounts } = quote;
  const other = otherSide(amounts);
  return (
    <dl className="space-y-1 text-meta">
      {entry.unit === "display" ? (
        <PreviewRow label={t("DashboardPayments.tokenAmount.quoteTokenAmount")}>
          {amount(entry.tokenAmount)}
        </PreviewRow>
      ) : null}
      {terms.transferFee === null ? null : (
        <PreviewRow label={t("DashboardPayments.tokenAmount.quoteFee")}>
          {amount(amounts.fee)}
        </PreviewRow>
      )}
      <PreviewRow label={t(other.label)}>{amount(other.amount)}</PreviewRow>
      {other.display === null || amounts.display === undefined ? null : (
        <PreviewRow label={t(other.displayLabel)}>
          <TokenDisplayAmount
            balance={{ displayRule: terms.display.rule, displayAsOf: amounts.display.asOf }}
            formatted={amount(other.display)}
          />
        </PreviewRow>
      )}
    </dl>
  );
}
