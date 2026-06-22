"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import {
  formatCurrencyAmount,
  resolveTotalBalance,
} from "@/app/dashboard/payments/payments-overview.utils";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toRampCryptoToken } from "@/lib/ramps";
import { findWalletBalanceForToken } from "../wallet-options";
import { AmountBalanceReadout } from "./amount-balance-readout";
import { useRampSelection } from "./ramp-selection-context";

export function CurrencyPairSelector() {
  const {
    direction,
    fiatCurrencies,
    assetRails,
    wallets,
    walletsLoading,
    selectedWallet,
    showWallet,
    selectedPair,
    amount,
    onAmountChange,
    onAmountBlur,
    onWalletChange,
    onFiatCurrencyChange,
    onAssetRailChange,
  } = useRampSelection();

  const currencyOptions = useMemo(
    () => fiatCurrencies.map((c) => ({ value: c, label: c })),
    [fiatCurrencies]
  );

  const walletOptions = useMemo(
    () =>
      wallets.map((w) => {
        const total = w.balances ? resolveTotalBalance(w.balances) : null;
        return {
          value: w.walletId,
          label: w.label ?? w.walletId,
          description: total !== null ? formatCurrencyAmount(total) : undefined,
        };
      }),
    [wallets]
  );

  const assetOptions = useMemo(
    () => assetRails.map((rail) => ({ value: rail, label: getCryptoRailAssetLabel(rail) })),
    [assetRails]
  );

  const isOfframp = direction === "offramp";

  const offrampBalance = useMemo<number | null>(() => {
    if (!isOfframp || !selectedWallet) {
      return null;
    }
    const balance = findWalletBalanceForToken(
      selectedWallet,
      toRampCryptoToken(selectedPair.assetRail)
    );
    return balance ? Number(balance.uiAmount) : 0;
  }, [isOfframp, selectedWallet, selectedPair.assetRail]);

  const offrampExceeds =
    offrampBalance !== null && amount !== "" && Number(amount) > offrampBalance;

  const fiatCombobox = (
    <Combobox
      label={isOfframp ? "Convert to" : "Currency"}
      value={selectedPair.fiatCurrency}
      onChange={(v) => {
        const currency = fiatCurrencies.find((c) => c === v);
        if (currency) onFiatCurrencyChange(currency);
      }}
      options={currencyOptions}
      placeholder="Search currencies"
      searchable={false}
    />
  );

  const assetCombobox = (
    <Combobox
      label={isOfframp ? "Asset" : "Convert to"}
      value={selectedPair.assetRail}
      onChange={(v) => {
        const rail = assetRails.find((r) => r === v);
        if (rail) onAssetRailChange(rail);
      }}
      options={assetOptions}
      placeholder="Search assets"
      searchable={false}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-text-low" htmlFor={`${direction}-ramp-amount`}>
            Amount
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
            className="h-[var(--input-height-xl)] shadow-none ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&>span:first-child]:h-[var(--input-height-xl)] [&>span:first-child]:border-0 [&>span:first-child]:bg-border-extra-light"
            action={
              offrampBalance !== null ? (
                <AmountBalanceReadout
                  available={String(offrampBalance)}
                  assetLabel={getCryptoRailAssetLabel(selectedPair.assetRail)}
                  exceeds={offrampExceeds}
                  onMax={
                    offrampBalance > 0 ? () => onAmountChange(String(offrampBalance)) : undefined
                  }
                />
              ) : undefined
            }
          />
        </div>
        {isOfframp ? assetCombobox : fiatCombobox}
      </div>

      <div className={showWallet ? "grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]" : "grid gap-4"}>
        {showWallet ? (
          <Combobox
            label={direction === "onramp" ? "Destination wallet" : "Source wallet"}
            value={selectedWallet?.walletId ?? null}
            onChange={onWalletChange}
            options={walletOptions}
            placeholder={
              direction === "onramp" ? "Select a destination wallet" : "Select a source wallet"
            }
            searchPlaceholder="Search wallets"
            icon={<WalletIcon className="size-5 shrink-0 text-text-low" />}
            isLoading={walletsLoading}
          />
        ) : null}
        {isOfframp ? fiatCombobox : assetCombobox}
      </div>
    </div>
  );
}
