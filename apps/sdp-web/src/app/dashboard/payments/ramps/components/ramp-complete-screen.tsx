"use client";

import type { PaymentRampQuote, PaymentTransferSummary } from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import { CheckCircle2Icon } from "lucide-react";
import {
  formatMinorCurrencyAmount,
  formatTimestamp,
} from "@/app/dashboard/payments/payments-overview.utils";
import { getRampProviderLabel } from "@/lib/ramps";

function TransferDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <span className="shrink-0 text-sm text-text-low">{label}</span>
      <span className="min-w-0 break-all text-right text-sm font-medium text-text-extra-high">
        {value}
      </span>
    </div>
  );
}

export function RampCompleteScreen({
  direction,
  quote,
  transfer,
}: {
  direction: RampDirection;
  quote: PaymentRampQuote;
  transfer: PaymentTransferSummary;
}) {
  const onramp = direction === "onramp";
  const cryptoAmount =
    transfer.amount && transfer.token ? `${transfer.amount} ${transfer.token.toUpperCase()}` : null;
  const fiatAmount =
    transfer.fiatAmount && transfer.fiatCurrency
      ? `${transfer.fiatAmount} ${transfer.fiatCurrency.toUpperCase()}`
      : null;

  // onramp: received crypto, funded with fiat. offramp: paid out fiat, sent crypto.
  const primaryAmount = onramp ? cryptoAmount : fiatAmount;
  const secondaryAmount = onramp ? fiatAmount : cryptoAmount;

  const detailRows: { label: string; value: string }[] = [];
  if (!primaryAmount && secondaryAmount) {
    detailRows.push({ label: onramp ? "Funded" : "Sent", value: secondaryAmount });
  }
  detailRows.push({ label: "Provider", value: getRampProviderLabel(quote.provider) });

  if (quote.provider === "lightspark") {
    const sendingAmount = formatMinorCurrencyAmount(
      quote.totalSendingAmount,
      quote.sendingCurrency.code,
      quote.sendingCurrency.decimals
    );
    const receivingAmount = formatMinorCurrencyAmount(
      quote.totalReceivingAmount,
      quote.receivingCurrency.code,
      quote.receivingCurrency.decimals
    );
    if (sendingAmount) {
      detailRows.push({
        label: onramp ? "Final funded amount" : "Final sent amount",
        value: sendingAmount,
      });
    }
    if (receivingAmount) {
      detailRows.push({
        label: onramp ? "Final received amount" : "Final payout amount",
        value: receivingAmount,
      });
    }
  }

  if (transfer.updatedAt) {
    detailRows.push({ label: "Completed", value: formatTimestamp(transfer.updatedAt) });
  }
  detailRows.push({ label: "Transfer ID", value: transfer.id });
  detailRows.push({ label: "Quote ID", value: quote.id });

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex size-16 items-center justify-center rounded-full bg-status-success-bg text-status-success-text">
        <CheckCircle2Icon className="size-8" />
      </div>
      <div className="space-y-1 text-center">
        <p className="text-2xl font-medium tracking-tight text-text-extra-high">
          {onramp ? "Deposit complete" : "Payout complete"}
        </p>
        <p className="text-sm text-text-low">
          {onramp
            ? "The funds have settled to the destination wallet."
            : "The payout has settled to the recipient's bank account."}
        </p>
      </div>
      <section className="w-full space-y-4 rounded-2xl bg-border-extra-light p-5">
        {primaryAmount ? (
          <div className="flex flex-col items-center gap-0.5 border-b border-border-light pb-4">
            <p className="text-3xl font-semibold tracking-tight text-text-extra-high">
              {primaryAmount}
            </p>
            {secondaryAmount ? (
              <p className="text-sm text-text-low">
                {onramp ? "funded with" : "from"} {secondaryAmount}
              </p>
            ) : null}
          </div>
        ) : null}
        <div>
          {detailRows.map((detail) => (
            <TransferDetailRow key={detail.label} label={detail.label} value={detail.value} />
          ))}
        </div>
      </section>
    </div>
  );
}
