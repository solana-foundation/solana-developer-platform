"use client";

import type { PaymentRampQuote, PaymentTransferSummary } from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import { CheckCircle2Icon, CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import {
  formatMinorCurrencyAmount,
  formatTimestamp,
  resolveTransferTokenLabel,
  shortenAddress,
} from "@/app/dashboard/payments/payments-overview.utils";
import { providerTransferDetailRows } from "@/app/dashboard/payments/provider-transfer-details";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { getRampProviderLabel } from "@/lib/ramps";
import { useCopy } from "@/lib/use-copy";
import { useSolanaCluster } from "@/lib/use-solana-cluster";

function TransferDetailRow({
  label,
  value,
  href,
  copyValue,
}: {
  label: string;
  value: string;
  href?: string;
  copyValue?: string;
}) {
  const t = useTranslations();
  const { copy, copied } = useCopy(1200);
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <span className="shrink-0 text-sm text-tertiary">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1 text-right text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {value}
          <ExternalLinkIcon className="size-3.5 shrink-0" />
        </a>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 break-all text-right text-sm font-medium text-primary">
            {value}
          </span>
          {copyValue ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("DashboardPayments.transferDetails.copy", { label })}
              onClick={() => void copy(copyValue)}
            >
              {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
            </Button>
          ) : null}
        </span>
      )}
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
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const onramp = direction === "onramp";
  const tokenLabel = resolveTransferTokenLabel(transfer.token);
  const cryptoAmount = transfer.amount && tokenLabel ? `${transfer.amount} ${tokenLabel}` : null;
  const fiatAmount =
    transfer.fiatAmount && transfer.fiatCurrency
      ? `${transfer.fiatAmount} ${transfer.fiatCurrency.toUpperCase()}`
      : null;

  // onramp: received crypto, funded with fiat. offramp: paid out fiat, sent crypto.
  const primaryAmount = onramp ? cryptoAmount : fiatAmount;
  const secondaryAmount = onramp ? fiatAmount : cryptoAmount;

  const detailRows: { label: string; value: string; href?: string; copyValue?: string }[] = [];
  if (!primaryAmount && secondaryAmount) {
    detailRows.push({
      label: onramp ? t("DashboardPayments.ramps.funded") : t("DashboardPayments.ramps.sent"),
      value: secondaryAmount,
    });
  }
  detailRows.push({
    label: t("DashboardPayments.ramps.provider"),
    value: getRampProviderLabel(quote.provider),
  });
  detailRows.push(...providerTransferDetailRows(transfer, { cluster }, t));

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
        label: onramp
          ? t("DashboardPayments.ramps.finalFundedAmount")
          : t("DashboardPayments.ramps.finalSentAmount"),
        value: sendingAmount,
      });
    }
    if (receivingAmount) {
      detailRows.push({
        label: onramp
          ? t("DashboardPayments.ramps.finalReceivedAmount")
          : t("DashboardPayments.ramps.finalPayoutAmount"),
        value: receivingAmount,
      });
    }
  }

  if (transfer.updatedAt) {
    detailRows.push({
      label: t("DashboardPayments.ramps.completed"),
      value: formatTimestamp(transfer.updatedAt, t),
    });
  }
  detailRows.push({
    label: t("DashboardPayments.ramps.transferId"),
    value: shortenAddress(transfer.id),
    copyValue: transfer.id,
  });

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex size-16 items-center justify-center rounded-full bg-success-bg text-success">
        <CheckCircle2Icon className="size-8" />
      </div>
      <div className="space-y-1 text-center">
        <p className="text-2xl font-medium tracking-tight text-primary">
          {onramp
            ? t("DashboardPayments.ramps.depositComplete")
            : t("DashboardPayments.ramps.payoutComplete")}
        </p>
        <p className="text-sm text-tertiary">
          {onramp
            ? t("DashboardPayments.ramps.depositCompleteDescription")
            : t("DashboardPayments.ramps.payoutCompleteDescription")}
        </p>
      </div>
      <section className="w-full space-y-4 rounded-2xl bg-fill-subtle p-5">
        {primaryAmount ? (
          <div className="flex flex-col items-center gap-0.5 border-b border-border-default pb-4">
            <p className="text-3xl font-semibold tracking-tight text-primary">{primaryAmount}</p>
            {secondaryAmount ? (
              <p className="text-sm text-tertiary">
                {onramp
                  ? t("DashboardPayments.ramps.fundedWith")
                  : t("DashboardPayments.ramps.from")}{" "}
                {secondaryAmount}
              </p>
            ) : null}
          </div>
        ) : null}
        <div>
          {detailRows.map((detail) => (
            <TransferDetailRow
              key={detail.label}
              label={detail.label}
              value={detail.value}
              href={detail.href}
              copyValue={detail.copyValue}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
