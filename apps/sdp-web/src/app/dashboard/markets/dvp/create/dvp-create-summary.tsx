"use client";

/**
 * The trade in words, before it is real.
 *
 * A form that moves value in two directions at once should say which way each
 * one goes, in the terms the person typed rather than the base units the chain
 * takes. The steps underneath exist because creating a trade is not the end of
 * the flow and nothing else on this page says so: the counterparty still has to
 * fund, and someone still has to settle.
 */

import { ArrowDownIcon, CheckIcon } from "lucide-react";
import { TokenMark } from "@/components/token-mark";
import { useTranslations } from "@/i18n/provider";
import { shortenAddress } from "../../../payments/payments-overview.utils";

function Leg({
  amount,
  direction,
  mint,
  symbol,
}: {
  amount: string;
  direction: string;
  mint: string | null;
  symbol: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-tertiary text-xs">{direction}</div>
      <div className="mt-1 flex items-center gap-2">
        <TokenMark mint={mint} size="sm" symbol={symbol} />
        <span className="truncate font-medium text-lg text-primary tabular-nums">
          {amount} <span className="text-secondary text-sm">{symbol}</span>
        </span>
      </div>
    </div>
  );
}

export function DvpCreateSummary({
  amountA,
  amountB,
  assetMint,
  assetSymbol,
  cashMint,
  cashSymbol,
  counterparty,
  ready,
  sdpSide,
}: {
  amountA: string;
  amountB: string;
  assetMint: string | null;
  assetSymbol: string;
  cashMint: string | null;
  cashSymbol: string;
  counterparty: string;
  ready: boolean;
  sdpSide: "a" | "b";
}) {
  const t = useTranslations();
  const asset = {
    amount: amountA,
    mint: assetMint,
    symbol: assetSymbol || t("DashboardMarkets.dvp.sideAsset"),
  };
  const cash = {
    amount: amountB,
    mint: cashMint,
    symbol: cashSymbol || t("DashboardMarkets.dvp.sideCash"),
  };
  const deliver = sdpSide === "a" ? asset : cash;
  const receive = sdpSide === "a" ? cash : asset;

  const steps = [
    t("DashboardMarkets.dvp.stepEscrows"),
    t("DashboardMarkets.dvp.stepFund", {
      counterparty: counterparty
        ? shortenAddress(counterparty)
        : t("DashboardMarkets.dvp.theirSide"),
    }),
    t("DashboardMarkets.dvp.stepSettle"),
  ];

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-5">
      <h2 className="font-medium text-primary text-sm">{t("DashboardMarkets.dvp.summaryTitle")}</h2>

      {ready ? (
        <div className="mt-4 grid gap-3">
          <Leg
            amount={deliver.amount}
            direction={t("DashboardMarkets.dvp.summaryYouDeliver")}
            mint={deliver.mint}
            symbol={deliver.symbol}
          />
          <ArrowDownIcon aria-hidden className="h-4 w-4 text-tertiary" />
          <Leg
            amount={receive.amount}
            direction={t("DashboardMarkets.dvp.summaryYouReceive")}
            mint={receive.mint}
            symbol={receive.symbol}
          />
        </div>
      ) : (
        <p className="mt-2 text-tertiary text-xs leading-relaxed">
          {t("DashboardMarkets.dvp.summaryIncomplete")}
        </p>
      )}

      <ol className="mt-5 grid gap-2 border-border-default border-t pt-4">
        {steps.map((step) => (
          <li className="flex items-start gap-2 text-secondary text-xs leading-relaxed" key={step}>
            <CheckIcon aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tertiary" />
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
