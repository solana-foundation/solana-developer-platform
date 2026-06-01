"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrencyAmount, resolveTotalBalance } from "../../payments-overview.utils";
import { useRampSelection } from "./ramp-selection-context";

export function CurrencyPairSelector() {
  const {
    direction,
    fiatCurrencies,
    assetRails,
    wallets,
    walletsLoading,
    selectedWallet,
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

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-text-low" htmlFor={`${direction}-ramp-amount`}>
            Amount
          </Label>
          <Input
            id={`${direction}-ramp-amount`}
            type="number"
            inputMode="decimal"
            min="1"
            step="0.01"
            value={amount}
            onChange={(event) => onAmountChange(event.currentTarget.value)}
            onBlur={onAmountBlur}
            placeholder="20.00"
            size="xl"
            className="shadow-none ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&>span:first-child]:border-0 [&>span:first-child]:bg-border-extra-light"
          />
        </div>
        <Combobox
          label="Currency"
          value={selectedPair.fiatCurrency}
          onChange={(v) => {
            const currency = fiatCurrencies.find((c) => c === v);
            if (currency) onFiatCurrencyChange(currency);
          }}
          options={currencyOptions}
          placeholder="Search currencies"
          searchable={false}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
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
        <Combobox
          label="Asset"
          value={selectedPair.assetRail}
          onChange={(v) => {
            const rail = assetRails.find((r) => r === v);
            if (rail) onAssetRailChange(rail);
          }}
          options={assetOptions}
          placeholder="Search assets"
          searchable={false}
        />
      </div>
    </div>
  );
}
