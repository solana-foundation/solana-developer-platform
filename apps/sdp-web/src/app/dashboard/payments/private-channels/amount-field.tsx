"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import type { WalletBalanceView } from "./wallet-balances";

interface AmountFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  /** Translated amount problem, shown in place of the balances. */
  error?: string | null;
  balances?: WalletBalanceView;
  /** Balance this flow spends, listed first because it is the one to check. */
  spends: "channel" | "onChain";
}

const BALANCE_LABEL_KEYS = {
  channel: "DashboardPrivateChannels.common.channelBalance",
  onChain: "DashboardPrivateChannels.common.onChainBalance",
} as const;

/**
 * The USDC amount input shared by the deposit, withdrawal, and transfer forms:
 * one label, one placeholder, one error treatment, and the wallet's balances
 * under the field so the amount can be checked against them while typing.
 */
export function AmountField({
  balances,
  disabled,
  error,
  id,
  onBlur,
  onChange,
  spends,
  value,
}: AmountFieldProps) {
  const t = useTranslations();
  const errorId = `${id}-error`;
  const order: Array<"channel" | "onChain"> =
    spends === "channel" ? ["channel", "onChain"] : ["onChain", "channel"];
  const shownBalances = order.flatMap((source) => {
    const amount = balances?.[source];
    return amount === null || amount === undefined ? [] : [{ amount, source }];
  });

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t("DashboardPrivateChannels.common.amountUsdc")}</Label>
      <Input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={Boolean(error)}
        autoComplete="off"
        disabled={disabled}
        id={id}
        inputMode="decimal"
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("DashboardPrivateChannels.common.amountPlaceholder")}
        value={value}
      />
      {error ? (
        <p className="text-destructive text-xs" id={errorId}>
          {error}
        </p>
      ) : (
        shownBalances.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {shownBalances.map(({ amount, source }) => (
              <span className="text-primary" key={source}>
                {t(BALANCE_LABEL_KEYS[source])}{" "}
                <span className="font-medium">
                  {t("DashboardPrivateChannels.common.amountWithUnit", { amount })}
                </span>
              </span>
            ))}
          </div>
        )
      )}
    </div>
  );
}
