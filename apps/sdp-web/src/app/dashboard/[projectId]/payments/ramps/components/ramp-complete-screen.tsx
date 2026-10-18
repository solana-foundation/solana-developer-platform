"use client";

import type { PaymentRampQuote, PaymentTransferSummary } from "@sdp/types/payments";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import Image from "next/image";
import {
  formatDisplayAmount,
  formatTimestamp,
  resolveTransferTokenLabel,
  shortenAddress,
} from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { providerTransferDetailRows } from "@/app/dashboard/[projectId]/payments/provider-transfer-details";
import { EntityLink } from "@/components/entity-link";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { getRampProviderLabel, RAMP_PROVIDER_LOGOS, RAMP_PROVIDER_WEBSITES } from "@/lib/ramps";
import { useCopy } from "@/lib/use-copy";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useSolanaCluster } from "@/lib/use-solana-cluster";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

interface CompletionDetailRow {
  label: string;
  value: string;
  href?: string;
  /** Internal entity page link (e.g. the destination custody wallet) rendered as an EntityLink. */
  entityHref?: string;
  copyValue?: string;
  /** Logo rendered before the value (e.g. the provider mark). */
  iconSrc?: string;
}

/** Derives the "Exchange rate" row from the transfer's fiat and crypto amounts. */
function derivedExchangeRateRow(
  transfer: PaymentTransferSummary,
  tokenLabel: string | null | undefined,
  t: Translate
): CompletionDetailRow | undefined {
  const fiatValue = Number(transfer.fiatAmount);
  const cryptoValue = Number(transfer.amount);
  const fiatCurrency = transfer.fiatCurrency;
  if (
    !tokenLabel ||
    !fiatCurrency ||
    !Number.isFinite(fiatValue) ||
    !Number.isFinite(cryptoValue) ||
    cryptoValue <= 0
  ) {
    return undefined;
  }
  return {
    label: t("DashboardPayments.transferDetails.exchangeRate"),
    value: `1 ${tokenLabel} = ${formatDisplayAmount(
      String(fiatValue / cryptoValue),
      fiatCurrency.toUpperCase()
    )}`,
  };
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
      iconSrc: RAMP_PROVIDER_LOGOS[quote.provider],
      href: RAMP_PROVIDER_WEBSITES[quote.provider],
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

  const exchangeRateRow = derivedExchangeRateRow(transfer, tokenLabel, t);
  const exchangeRate = exchangeRateRow?.value;
  if (exchangeRateRow) {
    rows.push(exchangeRateRow);
  }

  let receiptRow: CompletionDetailRow | undefined;
  for (const row of providerTransferDetailRows(transfer, { cluster }, t)) {
    if (row.key === "DashboardPayments.transferDetails.receipt") {
      receiptRow = row;
    } else if (!exchangeRate || row.key !== "DashboardPayments.transferDetails.exchangeRate") {
      rows.push(row);
    }
  }
  if (transfer.signature) {
    rows.push({
      label: onramp
        ? t("DashboardPayments.ramps.onchainTransaction")
        : t("DashboardPayments.ramps.depositTransaction"),
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
  entityHref,
  copyValue,
  iconSrc,
}: {
  label: string;
  value: string;
  href?: string;
  entityHref?: string;
  copyValue?: string;
  iconSrc?: string;
}) {
  const t = useTranslations();
  const toProjectHref = useProjectHref();
  const { copy, copied } = useCopy(1200);
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="shrink-0 text-sm text-tertiary">{label}</span>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {iconSrc ? (
          <Image
            src={iconSrc}
            alt=""
            width={16}
            height={16}
            className="size-4 shrink-0 rounded object-contain"
          />
        ) : null}
        {entityHref ? (
          <EntityLink href={toProjectHref(entityHref)}>{value}</EntityLink>
        ) : href ? (
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
            entityHref={detail.entityHref}
            copyValue={detail.copyValue}
            iconSrc={detail.iconSrc}
          />
        ))}
      </div>
    </section>
  );
}
