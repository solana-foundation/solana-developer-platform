"use client";

import type { PaymentRampEstimateFees, RampProviderEstimateResult } from "@sdp/types";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { Loader2Icon } from "lucide-react";
import { motion } from "motion/react";
import Image from "next/image";
import { RAMP_PROVIDER_LOGOS, type RampProviderOption } from "@/lib/ramps";
import { cn } from "@/lib/utils";

interface ProviderCardProps {
  option: RampProviderOption;
  active: boolean;
  estimate?: RampProviderEstimateResult;
  estimateLoading?: boolean;
  onSelect: () => void;
}

function formatEstimateDecimal(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  }).format(parsed);
}

function buildFeeLabel(fees: PaymentRampEstimateFees): string {
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
    return `Fees ${formatEstimateDecimal(providerFee)} ${providerCurrency} + ${formatEstimateDecimal(networkFee)} ${networkCurrency}`;
  }

  if (Number(fees.total) === 0) {
    return "No fees";
  }

  return `Fee ${formatEstimateDecimal(fees.total)} ${fees.currency}`;
}

function ProviderCardEstimate({
  estimate,
  estimateLoading,
}: {
  estimate?: RampProviderEstimateResult;
  estimateLoading?: boolean;
}) {
  if (estimateLoading) {
    return <Loader2Icon className="size-4 shrink-0 animate-spin text-text-low" />;
  }

  if (estimate?.status === "ok") {
    const { direction, fiatCurrency, assetRail, fiatAmount, cryptoAmount, fees } =
      estimate.estimate;
    const isFiatOut = direction === "offramp";
    const amount = formatEstimateDecimal(isFiatOut ? fiatAmount : cryptoAmount);
    const unit = isFiatOut ? fiatCurrency : getCryptoRailAssetLabel(assetRail);
    const feeLabel = buildFeeLabel(fees);

    return (
      <div className="shrink-0 text-right leading-none">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-text-low">
          Est. received
        </p>
        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
          <span className="text-sm leading-none font-semibold text-text-extra-high">{`≈ ${amount} ${unit}`}</span>
          <span className="rounded-full bg-border-extra-light px-2 py-0.5 text-xs leading-none font-medium text-text-low">
            {feeLabel}
          </span>
        </div>
      </div>
    );
  }

  if (estimate?.status === "unsupported") {
    return <p className="shrink-0 text-sm text-text-low">Rate known at quote</p>;
  }

  if (estimate?.status === "error") {
    return <p className="shrink-0 text-sm text-text-low">Unavailable</p>;
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
        "flex w-full items-center gap-3 rounded-xl bg-border-extra-light px-4 py-3 text-left outline outline-2 -outline-offset-2 transition-colors",
        active
          ? "outline-border-medium ring-2 ring-text-low ring-offset-2 ring-offset-white"
          : "outline-transparent hover:bg-border-light"
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
          "min-w-0 flex-1 text-lg leading-tight text-text-extra-high",
          active ? "font-medium" : "font-normal"
        )}
      >
        {option.title}
      </p>

      <ProviderCardEstimate estimate={estimate} estimateLoading={estimateLoading} />
    </motion.button>
  );
}
