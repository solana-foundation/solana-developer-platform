"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import {
  formatCurrencyAmount,
  resolveTotalBalance,
} from "@/app/dashboard/payments/payments-overview.utils";
import { useThemeScope } from "@/components/theme-scope";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { fiatCurrencyOptions } from "@/lib/fiat-currency-options";
import { findWalletBalanceForToken } from "../wallet-options";
import { AmountBalanceReadout } from "./amount-balance-readout";
import { useRampSelection } from "./ramp-selection-context";

/**
 * The fiat side of the pair. `hideLabel` is for the select beside the amount: on a refresh
 * surface the design draws it as a 96px unit picker under the amount's own label.
 */
function FiatCombobox({ hideLabel = false }: { hideLabel?: boolean }) {
  const t = useTranslations();
  const refresh = useThemeScope() === "refresh";
  const { direction, fiatCurrencies, selectedPair, onFiatCurrencyChange } = useRampSelection();
  // The design's unit picker reads "USD", not a flag and code; the list keeps the currency name.
  const currencyOptions = useMemo(
    () =>
      refresh
        ? fiatCurrencyOptions(fiatCurrencies).map((option) => ({ ...option, label: option.value }))
        : fiatCurrencyOptions(fiatCurrencies),
    [fiatCurrencies, refresh]
  );
  return (
    <Combobox
      label={
        direction === "offramp"
          ? t("DashboardPayments.ramps.convertTo")
          : t("DashboardPayments.ramps.currency")
      }
      hideLabel={hideLabel}
      value={selectedPair.fiatCurrency}
      onChange={(v) => {
        const currency = fiatCurrencies.find((c) => c === v);
        if (currency) onFiatCurrencyChange(currency);
      }}
      options={currencyOptions}
      placeholder={t("DashboardPayments.ramps.selectCurrency")}
      searchPlaceholder={t("DashboardPayments.ramps.searchCurrencies")}
      variant="dialog"
    />
  );
}

/** The crypto side of the pair. */
function AssetCombobox({ hideLabel = false }: { hideLabel?: boolean }) {
  const t = useTranslations();
  const { direction, assetRails, selectedPair, onAssetRailChange } = useRampSelection();
  const assetOptions = useMemo(
    () => assetRails.map((rail) => ({ value: rail, label: getCryptoRailAssetLabel(rail) })),
    [assetRails]
  );
  return (
    <Combobox
      label={
        direction === "offramp"
          ? t("DashboardPayments.asset")
          : t("DashboardPayments.ramps.convertTo")
      }
      hideLabel={hideLabel}
      value={selectedPair.assetRail}
      onChange={(v) => {
        const rail = assetRails.find((r) => r === v);
        if (rail) onAssetRailChange(rail);
      }}
      options={assetOptions}
      placeholder={t("DashboardPayments.ramps.searchAssets")}
      searchable={false}
    />
  );
}

/** The amount, with the wallet's balance in the asset (and a Max) when paying out of it. */
function RampAmountField() {
  const t = useTranslations();
  const { direction, selectedWallet, selectedPair, amount, onAmountChange, onAmountBlur } =
    useRampSelection();
  const isOfframp = direction === "offramp";
  const assetLabel = getCryptoRailAssetLabel(selectedPair.assetRail);
  const offrampBalance = useMemo<string | null>(() => {
    if (!isOfframp || !selectedWallet) {
      return null;
    }
    const balance = findWalletBalanceForToken(selectedWallet, assetLabel);
    return balance ? balance.uiAmount : "0";
  }, [isOfframp, selectedWallet, assetLabel]);
  const offrampExceeds =
    offrampBalance !== null && amount !== "" && Number(amount) > Number(offrampBalance);
  return (
    <div className="flex flex-col gap-2">
      <Label className="text-tertiary" htmlFor={`${direction}-ramp-amount`}>
        {t("DashboardPayments.ramps.amount")}
      </Label>
      <Input
        id={`${direction}-ramp-amount`}
        type="number"
        inputMode="decimal"
        min={isOfframp ? "0" : "1"}
        step={isOfframp ? "any" : "0.01"}
        value={amount}
        onChange={(event) => onAmountChange(event.currentTarget.value)}
        onBlur={onAmountBlur}
        placeholder={isOfframp ? "1.0" : "20.00"}
        size="xl"
        action={
          offrampBalance !== null ? (
            <AmountBalanceReadout
              available={offrampBalance}
              assetLabel={assetLabel}
              exceeds={offrampExceeds}
              onMax={Number(offrampBalance) > 0 ? () => onAmountChange(offrampBalance) : undefined}
            />
          ) : undefined
        }
      />
    </div>
  );
}

/** The wallet the deposit lands in, or the payout leaves from, with its total. */
function WalletCombobox() {
  const t = useTranslations();
  const { direction, wallets, walletsLoading, selectedWallet, onWalletChange } = useRampSelection();
  const walletOptions = useMemo(
    () =>
      wallets.map((w) => {
        const total = w.balances ? resolveTotalBalance(w.balances) : null;
        return {
          value: w.id,
          label: w.label ?? w.walletId,
          description: total !== null ? formatCurrencyAmount(total) : undefined,
        };
      }),
    [wallets]
  );
  return (
    <Combobox
      label={
        direction === "onramp"
          ? t("DashboardPayments.ramps.destinationWallet")
          : t("DashboardPayments.ramps.sourceWallet")
      }
      value={selectedWallet?.id ?? null}
      onChange={onWalletChange}
      options={walletOptions}
      placeholder={
        direction === "onramp"
          ? t("DashboardPayments.ramps.selectDestinationWallet")
          : t("DashboardPayments.ramps.selectSourceWallet")
      }
      searchPlaceholder={t("DashboardPayments.ramps.searchWallets")}
      icon={<WalletIcon className="size-5 shrink-0 text-tertiary" />}
      isLoading={walletsLoading}
    />
  );
}

export function CurrencyPairSelector() {
  const refresh = useThemeScope() === "refresh";
  const { direction, showWallet } = useRampSelection();
  const isOfframp = direction === "offramp";

  return (
    <div className="flex flex-col gap-4 refresh:gap-6">
      <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_200px] refresh:gap-3 refresh:sm:grid-cols-[minmax(0,1fr)_96px]">
        <RampAmountField />
        {isOfframp ? <AssetCombobox hideLabel={refresh} /> : <FiatCombobox hideLabel={refresh} />}
      </div>

      {/* A refresh surface stacks the wallet and the asset full width, one question per row. */}
      <div
        className={
          showWallet
            ? "grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px] refresh:gap-6 refresh:sm:grid-cols-1"
            : "grid gap-4 refresh:gap-6"
        }
      >
        {showWallet ? <WalletCombobox /> : null}
        {isOfframp ? <FiatCombobox /> : <AssetCombobox />}
      </div>
    </div>
  );
}
