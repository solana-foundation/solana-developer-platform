"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";

/**
 * The "Source wallet" field Pay and New schedule share: the wallet the payment leaves from.
 * Each flow states its own reason a wallet cannot sign, under the picker, as `children`.
 */
export function SourceWalletField({
  value,
  onChange,
  options,
  isLoading,
  disabled,
  trailing,
  children,
}: {
  /** The picked wallet's ID; empty while none is picked. */
  value: string;
  onChange: (walletId: string) => void;
  options: readonly ComboboxOption[];
  isLoading?: boolean;
  disabled?: boolean;
  /** Shown beside the picked wallet, e.g. its total. */
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-2">
      <Combobox
        label={t("DashboardPayments.onchainSend.sourceWallet")}
        value={value === "" ? null : value}
        onChange={onChange}
        options={options}
        placeholder={t("DashboardPayments.onchainSend.selectSourceWallet")}
        searchPlaceholder={t("DashboardPayments.onchainSend.searchWallets")}
        isLoading={isLoading}
        disabled={disabled}
        trailing={trailing}
      />
      {children}
    </div>
  );
}

/** The token picker beside the amount. */
export interface AmountTokenControls {
  /** The picked token; empty while none is picked. */
  value: string;
  onChange: (token: string) => void;
  options: readonly ComboboxOption[];
  placeholder: string;
  disabled: boolean;
}

/**
 * The amount beside its token, as Pay and New schedule share them. With `onMax` a Max button
 * sits between the two and the row tightens to fit it. The balance the amount is checked
 * against, and any reason there is none, go under the fields as `children`.
 */
export function AmountFields({
  id,
  label,
  value,
  onChange,
  maxDecimals,
  onMax,
  maxDisabled,
  token,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (amount: string) => void;
  /** The most decimals the token takes; longer input is not accepted. */
  maxDecimals?: number | null;
  /** Fills in the whole balance; the Max button is left out without it. */
  onMax?: () => void;
  maxDisabled?: boolean;
  token: AmountTokenControls;
  children?: ReactNode;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-2">
      <div
        className={
          onMax
            ? "grid items-end gap-x-4 gap-y-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,0.9fr)]"
            : "grid gap-6 sm:grid-cols-2"
        }
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={id}>{label}</Label>
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            placeholder="0.00"
            size="xl"
            maxDecimals={maxDecimals}
          />
        </div>
        {onMax ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mb-1 self-end"
            disabled={maxDisabled}
            onClick={onMax}
          >
            {t("DashboardPayments.payForm.max")}
          </Button>
        ) : null}
        <Combobox
          label={t("DashboardPayments.payForm.token")}
          value={token.value === "" ? null : token.value}
          onChange={token.onChange}
          options={token.options}
          placeholder={token.placeholder}
          searchable={false}
          disabled={token.disabled}
          size="xl"
        />
      </div>
      {children}
    </div>
  );
}
