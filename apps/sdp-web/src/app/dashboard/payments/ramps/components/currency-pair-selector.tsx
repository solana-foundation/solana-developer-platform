"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { WalletIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { formatCurrencyAmount, resolveTotalBalance } from "../../payments-overview.utils";
import { useRampSelection } from "./ramp-selection-context";

const borderlessControlClassName =
  "shadow-none ring-0 [&>span:first-child]:border-0 [&>span:first-child]:bg-border-extra-light";
const fieldWrapperClassName = "flex flex-col gap-2";
const fieldLabelClassName = "text-sm font-medium text-text-low";

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
  const selectedWalletName = selectedWallet
    ? selectedWallet.label
    : direction === "onramp"
      ? "Select a destination wallet"
      : "Select a source wallet";
  const selectedAssetLabel = getCryptoRailAssetLabel(selectedPair.assetRail);
  const selectedWalletTotalBalance = selectedWallet?.balances
    ? resolveTotalBalance(selectedWallet.balances)
    : null;
  const selectedWalletBalanceLabel =
    selectedWalletTotalBalance !== null ? formatCurrencyAmount(selectedWalletTotalBalance) : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_128px]">
        <div className={fieldWrapperClassName}>
          <Label className={fieldLabelClassName} htmlFor={`${direction}-ramp-amount`}>
            Amount
          </Label>
          <Input
            id={`${direction}-ramp-amount`}
            type="number"
            inputMode="decimal"
            min="0.000001"
            step="any"
            value={amount}
            onChange={(event) => onAmountChange(event.currentTarget.value)}
            onBlur={onAmountBlur}
            placeholder="20.00"
            size="xl"
            className={`${borderlessControlClassName} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
          />
        </div>
        <div className={fieldWrapperClassName}>
          <Label className={fieldLabelClassName}>Currency</Label>
          <Select
            className={`w-full ${borderlessControlClassName}`}
            onValueChange={(value) => {
              const fiatCurrency = fiatCurrencies.find((currency) => currency === value);
              if (fiatCurrency) {
                onFiatCurrencyChange(fiatCurrency);
              }
            }}
            placeholder="Select fiat"
            size="xl"
            value={selectedPair.fiatCurrency}
          >
            {fiatCurrencies.map((currency) => (
              <SelectItem key={currency} value={currency}>
                {currency}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_128px]">
        <div className={fieldWrapperClassName}>
          <Label className={fieldLabelClassName}>
            {direction === "onramp" ? "Destination wallet" : "Source wallet"}
          </Label>
          {walletsLoading ? (
            <div className="h-[var(--input-height-xl)] animate-pulse rounded-[var(--input-radius-xl)] bg-border-extra-light" />
          ) : (
            <div className="relative">
              <WalletIcon className="pointer-events-none absolute top-1/2 left-[var(--input-padding-x-xl)] z-10 size-5 -translate-y-1/2 text-text-low" />
              <span className="pointer-events-none absolute top-1/2 right-10 left-[calc(var(--input-padding-x-xl)+1.75rem)] z-10 flex -translate-y-1/2 items-center gap-2 text-[length:var(--input-text-size-xl)]">
                <span
                  className={`truncate ${selectedWallet ? "text-text-extra-high" : "text-text-low"}`}
                >
                  {selectedWalletName}
                </span>
                {selectedWalletBalanceLabel ? (
                  <span className="shrink-0 text-sm text-text-low">
                    {selectedWalletBalanceLabel}
                  </span>
                ) : null}
              </span>
              <Select
                className={`w-full [&>span:nth-child(3)]:text-transparent ${borderlessControlClassName}`}
                disabled={wallets.length === 0}
                onValueChange={(value) => {
                  if (value) {
                    onWalletChange(value);
                  }
                }}
                placeholder=""
                size="xl"
                value={selectedWallet?.walletId ?? null}
              >
                {wallets.map((wallet) => (
                  <SelectItem key={wallet.walletId} value={wallet.walletId}>
                    {wallet.label}
                  </SelectItem>
                ))}
              </Select>
            </div>
          )}
        </div>
        <div className={fieldWrapperClassName}>
          <Label className={fieldLabelClassName}>Asset</Label>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 right-10 left-[var(--input-padding-x-xl)] z-10 -translate-y-1/2 truncate text-[length:var(--input-text-size-xl)] text-text-extra-high">
              {selectedAssetLabel}
            </span>
            <Select
              className={`w-full [&>span:nth-child(3)]:text-transparent ${borderlessControlClassName}`}
              onValueChange={(value) => {
                const assetRail = assetRails.find((rail) => rail === value);
                if (assetRail) {
                  onAssetRailChange(assetRail);
                }
              }}
              placeholder="Select asset"
              size="xl"
              value={selectedPair.assetRail}
            >
              {assetRails.map((assetRail) => (
                <SelectItem key={assetRail} value={assetRail}>
                  {getCryptoRailAssetLabel(assetRail)}
                </SelectItem>
              ))}
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}
