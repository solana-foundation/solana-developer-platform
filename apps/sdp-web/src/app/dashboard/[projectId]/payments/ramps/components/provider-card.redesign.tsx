"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { RampProviderEstimateResult } from "@sdp/types/payments";
import { cn } from "@sdp/ui/cn";
import { domMax, LazyMotion, m } from "motion/react";
import Image from "next/image";
import {
  estimateFeeCopy,
  estimateLimitCopy,
  estimateRateCopy,
  formatEstimateFigure,
} from "@/app/dashboard/[projectId]/payments/ramps/ramp-estimate-copy";
import { useLocale, useTranslations } from "@/i18n/provider";
import { RAMP_PROVIDER_LOGOS, type RampProviderOption } from "@/lib/ramps";
import { ProviderCardEstimate } from "./provider-card-estimate";

interface ProviderCardProps {
  option: RampProviderOption;
  active: boolean;
  estimate?: RampProviderEstimateResult;
  estimateLoading?: boolean;
  onSelect: () => void;
}

export function ProviderCard({
  option,
  active,
  estimate,
  estimateLoading,
  onSelect,
}: ProviderCardProps) {
  return (
    <LazyMotion features={domMax}>
      <m.button
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
      </m.button>
    </LazyMotion>
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
      <span className="block" aria-busy="true">
        <span className="block h-4 w-24 animate-pulse rounded bg-fill" />
        <span className="mt-1.5 block h-[30px] w-32 animate-pulse rounded bg-fill" />
        <span className="mt-1 block h-4 w-20 animate-pulse rounded bg-fill" />
      </span>
    );
  }
  if (estimate?.status === "error") {
    // The provider's own error text is not written for users; the tile says what happened and
    // what to try instead, naming the amount that would work when the provider set a bound.
    return (
      <span className="space-y-1">
        <span className="block text-meta text-tertiary">
          {t("DashboardPayments.ramps.unavailable")}
        </span>
        <span className="block text-body text-secondary">
          {estimateLimitCopy(t, estimate) ?? t("DashboardPayments.ramps.noQuote")}
        </span>
      </span>
    );
  }
  if (estimate?.status !== "ok") {
    return (
      <span className="block text-meta text-tertiary">
        {estimate?.status === "unsupported"
          ? t("DashboardPayments.ramps.rateKnownAtQuote")
          : t("DashboardPayments.ramps.enterAmountForQuote")}
      </span>
    );
  }
  const ok = estimate.estimate;
  const isFiatOut = ok.direction === "offramp";
  // A payout is the crypto at the rate, less the fee; without the rate the numbers don't add up.
  const saleRate = isFiatOut ? estimateRateCopy(t, ok, locale) : null;
  // 13px line, 6px, the 24px figure on its 30px line, 4px, 13px line: 72px, as the design draws it.
  return (
    <span className="block">
      <span className="block text-meta text-secondary">
        {isFiatOut
          ? t("DashboardPayments.ramps.recipientReceives")
          : t("DashboardPayments.ramps.walletReceives")}
      </span>
      <span className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-quote font-medium text-primary tabular-nums">
          {formatEstimateFigure(isFiatOut ? ok.fiatAmount : ok.cryptoAmount, locale)}
        </span>
        <span className="text-body text-secondary">
          {isFiatOut ? ok.fiatCurrency : getCryptoRailAssetLabel(ok.assetRail)}
        </span>
      </span>
      <span className="mt-1 block text-meta text-tertiary">
        {estimateFeeCopy(t, ok.fees, locale)}
        {saleRate ? ` · ${saleRate}` : null}
      </span>
    </span>
  );
}

/**
 * A provider as one tile in the refresh quote grid: a 28px logo and the name with a 16px radio
 * mark, then what the wallet receives and the fee pinned to the foot. The tile has no height
 * of its own: the grid gives every row the tallest tile's height, so a tile with a second
 * name line ("Sandbox only") sets the height for all of them and the quotes line up. The tile
 * is a label around a native radio, so the grid gets radio-group keyboard behaviour for free.
 * An unavailable provider keeps its tile, disabled, with the first reason it cannot be used,
 * so the grid shows every option.
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
    // Relative, so the hidden radio is placed (and scrolled into view on focus) inside the
    // card, not by the page, which would shift the whole locked page up.
    <label
      className={cn(
        "relative flex w-full cursor-pointer flex-col justify-between gap-6 rounded-card border p-5 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary",
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
          width={28}
          height={28}
          className={cn("size-7 shrink-0 rounded-full object-contain", disabled && "opacity-50")}
        />
        <span className="min-w-0 flex-1 pt-1">
          <span
            className={cn("block text-body font-medium text-primary", disabled && "text-muted")}
          >
            {option.title}
          </span>
          {sandboxOnly ? (
            <span className="block text-meta text-secondary">
              {t("DashboardPayments.ramps.sandboxOnly")}
            </span>
          ) : null}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "mt-1.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
            active ? "border-primary" : "border-border-strong"
          )}
        >
          {active ? <span className="size-2 rounded-full bg-primary" /> : null}
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
