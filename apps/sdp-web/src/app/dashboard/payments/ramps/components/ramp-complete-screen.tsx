"use client";

import type { PaymentRampQuote, PaymentTransferSummary, SolanaCluster } from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import {
  formatDisplayAmount,
  formatMinorCurrencyAmount,
  formatTimestamp,
  resolveTransferTokenLabel,
  shortenAddress,
} from "@/app/dashboard/payments/payments-overview.utils";
import { providerTransferDetailRows } from "@/app/dashboard/payments/provider-transfer-details";
import { Button } from "@/components/ui/button";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { getRampProviderLabel } from "@/lib/ramps";
import { useCopy } from "@/lib/use-copy";
import { useSolanaCluster } from "@/lib/use-solana-cluster";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

interface CompletionDetailRow {
  label: string;
  value: string;
  href?: string;
  copyValue?: string;
}

function completionDetailRows(
  quote: PaymentRampQuote,
  transfer: PaymentTransferSummary,
  cluster: SolanaCluster,
  onramp: boolean,
  tokenLabel: string | null | undefined,
  t: Translate
): CompletionDetailRow[] {
  const rows: CompletionDetailRow[] = [
    {
      label: t("DashboardPayments.ramps.provider"),
      value: getRampProviderLabel(quote.provider),
    },
  ];
  if (transfer.providerReference) {
    rows.push({
      label: t("DashboardPayments.transferDetails.providerReference"),
      value: transfer.providerReference,
      copyValue: transfer.providerReference,
    });
  }
  rows.push({
    label: t("DashboardPayments.ramps.transferId"),
    value: transfer.id,
    copyValue: transfer.id,
  });

  const cryptoValue = Number(transfer.amount);
  const fiatValue = Number(transfer.fiatAmount);
  const fiatCurrency = transfer.fiatCurrency;
  let exchangeRate: string | undefined;
  if (
    tokenLabel &&
    fiatCurrency &&
    Number.isFinite(cryptoValue) &&
    cryptoValue > 0 &&
    Number.isFinite(fiatValue)
  ) {
    exchangeRate = `1 ${tokenLabel} = ${formatDisplayAmount(
      String(fiatValue / cryptoValue),
      fiatCurrency.toUpperCase()
    )}`;
    rows.push({
      label: t("DashboardPayments.transferDetails.exchangeRate"),
      value: exchangeRate,
    });
  }

  let receiptRow: CompletionDetailRow | undefined;
  for (const row of providerTransferDetailRows(transfer, { cluster }, t)) {
    if (row.key === "DashboardPayments.transferDetails.receipt") {
      receiptRow = row;
    } else if (!exchangeRate || row.key !== "DashboardPayments.transferDetails.exchangeRate") {
      rows.push(row);
    }
  }
  if (!onramp && transfer.signature) {
    rows.push({
      label: t("DashboardPayments.ramps.depositTransaction"),
      value: shortenAddress(transfer.signature),
      href: explorerTxUrl(transfer.signature, cluster),
      copyValue: transfer.signature,
    });
  }
  if (!onramp && transfer.destination) {
    rows.push({
      label: t("DashboardPayments.manualInstructions.depositAddress"),
      value: shortenAddress(transfer.destination),
      copyValue: transfer.destination,
    });
  }
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
      rows.push({
        label: onramp
          ? t("DashboardPayments.ramps.finalFundedAmount")
          : t("DashboardPayments.ramps.finalSentAmount"),
        value: sendingAmount,
      });
    }
    if (receivingAmount) {
      rows.push({
        label: onramp
          ? t("DashboardPayments.ramps.finalReceivedAmount")
          : t("DashboardPayments.ramps.finalPayoutAmount"),
        value: receivingAmount,
      });
    }
  }
  if (transfer.createdAt) {
    rows.push({
      label: t("DashboardPayments.createdLabel"),
      value: formatTimestamp(transfer.createdAt, t),
    });
  }
  if (transfer.updatedAt) {
    rows.push({
      label: t("DashboardPayments.ramps.completed"),
      value: formatTimestamp(transfer.updatedAt, t),
    });
  }
  if (receiptRow) {
    rows.push(receiptRow);
  }
  return rows;
}

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
    <div className="flex items-center justify-between gap-4">
      <span className="shrink-0 text-sm text-tertiary">{label}</span>
      <span className="inline-flex min-w-0 items-center gap-1.5">
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
          <span className="min-w-0 break-all text-right text-sm font-medium text-primary">
            {value}
          </span>
        )}
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

  const primaryAmount = onramp ? cryptoAmount : fiatAmount;
  const secondaryAmount = onramp ? fiatAmount : cryptoAmount;
  const detailRows = completionDetailRows(quote, transfer, cluster, onramp, tokenLabel, t);

  return (
    <section className="w-full overflow-hidden rounded-2xl bg-fill-subtle">
      {primaryAmount ? (
        <div className="flex flex-col items-center gap-0.5 border-b border-border-default px-5 py-5">
          <p className="text-3xl font-semibold tracking-tight text-primary">{primaryAmount}</p>
          {secondaryAmount ? (
            <p className="text-sm text-tertiary">
              {onramp ? t("DashboardPayments.ramps.fundedWith") : t("DashboardPayments.ramps.from")}{" "}
              {secondaryAmount}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-5 p-5">
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
  );
}
