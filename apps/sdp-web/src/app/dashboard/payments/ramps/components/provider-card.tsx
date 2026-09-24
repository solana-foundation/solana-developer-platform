"use client";

import type { PaymentRampEstimateFees, RampProviderEstimateResult } from "@sdp/types";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { Loader2Icon } from "lucide-react";
import { motion } from "motion/react";
import Image from "next/image";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { RAMP_PROVIDER_LOGOS, type RampProviderOption } from "@/lib/ramps";
import { cn } from "@/lib/utils";

interface ProviderCardProps {
  option: RampProviderOption;
  active: boolean;
  estimate?: RampProviderEstimateResult;
  estimateLoading?: boolean;
  onSelect: () => void;
}

function formatEstimateDecimal(value: string, locale: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  }).format(parsed);
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;

function buildFeeLabel(t: Translate, fees: PaymentRampEstimateFees, locale: string): string {
  const networkFee = fees.network;
  const providerFee = fees.provider;
  const network = networkFee !== undefined ? Number(networkFee) : undefined;
  const provider = providerFee !== undefined ? Number(providerFee) : undefined;
  const providerCurrency = fees.providerCurrency;
  const networkCurrency = fees.networkCurrency;

  if (
    providerFee !== undefined &&
    provider !== undefined &&
    provider > 0 &&
    networkFee !== undefined &&
    network !== undefined &&
    network > 0 &&
    providerCurrency &&
    networkCurrency &&
    providerCurrency !== networkCurrency
  ) {
    return t("DashboardPayments.ramps.fees", {
      providerFee: formatEstimateDecimal(providerFee, locale),
      providerCurrency,
      networkFee: formatEstimateDecimal(networkFee, locale),
      networkCurrency,
    });
  }

  if (Number(fees.total) === 0) {
    return t("DashboardPayments.ramps.noFees");
  }

  return t("DashboardPayments.ramps.fee", {
    amount: formatEstimateDecimal(fees.total, locale),
    currency: fees.currency,
  });
}

function ProviderCardEstimate({
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
    const amount = formatEstimateDecimal(isFiatOut ? fiatAmount : cryptoAmount, locale);
    const unit = isFiatOut ? fiatCurrency : getCryptoRailAssetLabel(assetRail);
    const feeLabel = buildFeeLabel(t, fees, locale);

    return (
      <div className="shrink-0 text-right leading-none">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-tertiary">
          {t("DashboardPayments.ramps.estimatedReceived")}
        </p>
        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
          <span className="text-sm leading-none font-semibold text-primary">{`≈ ${amount} ${unit}`}</span>
          <span className="rounded-full bg-fill-subtle px-2 py-0.5 text-xs leading-none font-medium text-tertiary">
            {feeLabel}
          </span>
        </div>
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
      <p className="shrink-0 text-sm text-tertiary">{t("DashboardPayments.ramps.unavailable")}</p>
    );
  }

  return null;
}

export function ProviderCard({
  option,
  active,
  estimate,
  estimateLoading,
  onSelect,
}: ProviderCardProps) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{
        layout: { type: "spring", stiffness: 500, damping: 40, mass: 0.6 },
        opacity: { duration: 0.15 },
        scale: { duration: 0.15 },
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-left outline outline-2 -outline-offset-2 transition-colors",
        active
          ? "outline-border-strong ring-2 ring-tertiary ring-offset-2 ring-offset-surface-raised"
          : "outline-transparent hover:bg-fill-strong"
      )}
    >
      <Image
        src={RAMP_PROVIDER_LOGOS[option.id]}
        alt=""
        width={32}
        height={32}
        className="size-8 shrink-0 rounded-lg object-contain"
      />

      <p
        className={cn(
          "min-w-0 flex-1 text-lg leading-tight text-primary",
          active ? "font-medium" : "font-normal"
        )}
      >
        {option.title}
      </p>

      <ProviderCardEstimate estimate={estimate} estimateLoading={estimateLoading} />
    </motion.button>
  );
}

function QuoteCardEstimate({
  estimate,
  estimateLoading,
  unavailableReason,
}: {
  estimate?: RampProviderEstimateResult;
  estimateLoading?: boolean;
  unavailableReason?: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (unavailableReason !== undefined) {
    return (
      <span className="space-y-1">
        <span className="block text-meta text-tertiary">
          {t("DashboardPayments.ramps.unavailable")}
        </span>
        <span className="block text-body text-secondary">{unavailableReason}</span>
      </span>
    );
  }
  if (estimateLoading) {
    return (
      <span className="space-y-2" aria-busy="true">
        <span className="block h-3.5 w-24 animate-pulse rounded bg-fill" />
        <span className="block h-7 w-32 animate-pulse rounded bg-fill" />
      </span>
    );
  }
  if (estimate?.status !== "ok") {
    return (
      <span className="block text-meta text-tertiary">
        {estimate?.status === "unsupported"
          ? t("DashboardPayments.ramps.rateKnownAtQuote")
          : estimate?.status === "error"
            ? t("DashboardPayments.ramps.unavailable")
            : t("DashboardPayments.ramps.enterAmountForQuote")}
      </span>
    );
  }
  const ok = estimate.estimate;
  const isFiatOut = ok.direction === "offramp";
  return (
    <span className="space-y-1">
      <span className="block text-meta text-secondary">
        {isFiatOut
          ? t("DashboardPayments.ramps.recipientReceives")
          : t("DashboardPayments.ramps.walletReceives")}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-quote font-medium text-primary tabular-nums">
          {formatEstimateDecimal(isFiatOut ? ok.fiatAmount : ok.cryptoAmount, locale)}
        </span>
        <span className="text-body text-secondary">
          {isFiatOut ? ok.fiatCurrency : getCryptoRailAssetLabel(ok.assetRail)}
        </span>
      </span>
      <span className="block text-meta text-tertiary">{buildFeeLabel(t, ok.fees, locale)}</span>
    </span>
  );
}

/**
 * A provider as one tile in the refresh quote grid: logo and name with a radio mark, then what
 * the wallet receives and the fee. The tile is a label around a native radio, so the grid
 * gets radio-group keyboard behaviour for free. An unavailable provider keeps its tile,
 * disabled, with the first reason it cannot be used, so the grid shows every option.
 */
export function ProviderQuoteCard({
  name,
  option,
  active,
  estimate,
  estimateLoading,
  sandboxOnly,
  unavailableReason,
  onSelect,
}: {
  /** Shared by every tile in one grid, which makes them one radio group. */
  name: string;
  option: RampProviderOption;
  active: boolean;
  estimate?: RampProviderEstimateResult;
  estimateLoading?: boolean;
  sandboxOnly?: boolean;
  unavailableReason?: string;
  onSelect: () => void;
}) {
  const t = useTranslations();
  const disabled = unavailableReason !== undefined;
  return (
    <label
      className={cn(
        "flex min-h-40 w-full cursor-pointer flex-col justify-between gap-6 rounded-card border p-5 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary",
        active ? "border-primary" : "border-border-strong hover:bg-fill-subtle",
        disabled && "cursor-not-allowed hover:bg-transparent"
      )}
    >
      <input
        type="radio"
        name={name}
        value={option.id}
        checked={active}
        disabled={disabled}
        onChange={onSelect}
        className="sr-only"
      />
      <span className="flex w-full items-start gap-3">
        <Image
          src={RAMP_PROVIDER_LOGOS[option.id]}
          alt=""
          width={40}
          height={40}
          className={cn("size-10 shrink-0 rounded-full object-contain", disabled && "opacity-50")}
        />
        <span className="min-w-0 flex-1 pt-2">
          <span className={cn("block text-body text-primary", disabled && "text-muted")}>
            {option.title}
          </span>
          {sandboxOnly ? (
            <span className="block text-body text-secondary">
              {t("DashboardPayments.ramps.sandboxOnly")}
            </span>
          ) : null}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "mt-2 flex size-5 shrink-0 items-center justify-center rounded-full border",
            active ? "border-primary" : "border-border-strong"
          )}
        >
          {active ? <span className="size-2.5 rounded-full bg-primary" /> : null}
        </span>
      </span>
      <QuoteCardEstimate
        estimate={estimate}
        estimateLoading={estimateLoading}
        unavailableReason={unavailableReason}
      />
    </label>
  );
}
