"use client";

import type { PaymentRampQuote, PaymentTransferSummary, SolanaCluster } from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import { ArrowRightIcon, CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
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

function isDetailRow(row: CompletionDetailRow | null): row is CompletionDetailRow {
  return row !== null;
}

function rampExchangeRate(
  transfer: PaymentTransferSummary,
  tokenLabel: string | null | undefined
): string | null {
  const cryptoValue = Number(transfer.amount);
  const fiatValue = Number(transfer.fiatAmount);
  if (
    !tokenLabel ||
    !transfer.fiatCurrency ||
    !Number.isFinite(cryptoValue) ||
    cryptoValue <= 0 ||
    !Number.isFinite(fiatValue)
  ) {
    return null;
  }
  return `1 ${tokenLabel} = ${formatDisplayAmount(
    String(fiatValue / cryptoValue),
    transfer.fiatCurrency.toUpperCase()
  )}`;
}

function lightsparkCompletionRows(
  quote: PaymentRampQuote,
  onramp: boolean,
  t: Translate
): CompletionDetailRow[] {
  if (quote.provider !== "lightspark") {
    return [];
  }
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
  return [
    sendingAmount
      ? {
          label: onramp
            ? t("DashboardPayments.ramps.finalFundedAmount")
            : t("DashboardPayments.ramps.finalSentAmount"),
          value: sendingAmount,
        }
      : null,
    receivingAmount
      ? {
          label: onramp
            ? t("DashboardPayments.ramps.finalReceivedAmount")
            : t("DashboardPayments.ramps.finalPayoutAmount"),
          value: receivingAmount,
        }
      : null,
  ].filter(isDetailRow);
}

function offrampDepositRows(
  transfer: PaymentTransferSummary,
  cluster: SolanaCluster,
  t: Translate
): CompletionDetailRow[] {
  const rows: (CompletionDetailRow | null)[] = [
    transfer.signature
      ? {
          label: t("DashboardPayments.ramps.depositTransaction"),
          value: shortenAddress(transfer.signature),
          href: explorerTxUrl(transfer.signature, cluster),
          copyValue: transfer.signature,
        }
      : null,
    transfer.destination
      ? {
          label: t("DashboardPayments.manualInstructions.depositAddress"),
          value: shortenAddress(transfer.destination),
          copyValue: transfer.destination,
        }
      : null,
  ];
  return rows.filter(isDetailRow);
}

function completionDetailRows({
  quote,
  transfer,
  cluster,
  onramp,
  tokenLabel,
  t,
}: {
  quote: PaymentRampQuote;
  transfer: PaymentTransferSummary;
  cluster: SolanaCluster;
  onramp: boolean;
  tokenLabel: string | null | undefined;
  t: Translate;
}): CompletionDetailRow[] {
  const exchangeRate = rampExchangeRate(transfer, tokenLabel);
  const providerRows = providerTransferDetailRows(transfer, { cluster }, t).filter(
    (row) => !exchangeRate || row.key !== "DashboardPayments.transferDetails.exchangeRate"
  );
  const receiptRow = providerRows.find(
    (row) => row.key === "DashboardPayments.transferDetails.receipt"
  );
  const economicsRows = providerRows.filter(
    (row) => row.key !== "DashboardPayments.transferDetails.receipt"
  );
  return [
    {
      label: t("DashboardPayments.ramps.provider"),
      value: getRampProviderLabel(quote.provider),
    },
    transfer.providerReference
      ? {
          label: t("DashboardPayments.transferDetails.providerReference"),
          value: transfer.providerReference,
          copyValue: transfer.providerReference,
        }
      : null,
    {
      label: t("DashboardPayments.ramps.transferId"),
      value: transfer.id,
      copyValue: transfer.id,
    },
    exchangeRate
      ? {
          label: t("DashboardPayments.transferDetails.exchangeRate"),
          value: exchangeRate,
        }
      : null,
    ...economicsRows,
    ...(onramp ? [] : offrampDepositRows(transfer, cluster, t)),
    ...lightsparkCompletionRows(quote, onramp, t),
    transfer.createdAt
      ? {
          label: t("DashboardPayments.createdLabel"),
          value: formatTimestamp(transfer.createdAt, t),
        }
      : null,
    transfer.updatedAt
      ? {
          label: t("DashboardPayments.ramps.completed"),
          value: formatTimestamp(transfer.updatedAt, t),
        }
      : null,
    receiptRow ?? null,
  ].filter(isDetailRow);
}

function CompletionAmountFlow({
  sourceAmount,
  destinationAmount,
}: {
  sourceAmount: string | null;
  destinationAmount: string | null;
}) {
  if (!sourceAmount && !destinationAmount) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5 border-b border-border-default pb-4 text-base font-medium text-primary">
      {sourceAmount ? <span>{sourceAmount}</span> : null}
      {sourceAmount && destinationAmount ? (
        <ArrowRightIcon aria-hidden className="size-4 shrink-0 text-tertiary" />
      ) : null}
      {destinationAmount ? <span>{destinationAmount}</span> : null}
    </div>
  );
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
    <div className="flex min-h-12 items-center justify-between gap-4 py-2.5">
      <span className="shrink-0 text-sm text-tertiary">{label}</span>
      {href ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1 text-right text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {value}
            <ExternalLinkIcon className="size-3.5 shrink-0" />
          </a>
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
  const detailRows = completionDetailRows({
    quote,
    transfer,
    cluster,
    onramp,
    tokenLabel,
    t,
  });

  return (
    <section className="w-full space-y-4 rounded-2xl bg-fill-subtle p-5">
      <CompletionAmountFlow sourceAmount={secondaryAmount} destinationAmount={primaryAmount} />
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
  );
}
