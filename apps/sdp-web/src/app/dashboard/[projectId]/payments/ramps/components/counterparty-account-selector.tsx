"use client";

import type { CounterpartyAccount } from "@sdp/types";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";
import { useTranslations } from "@/i18n/provider";

interface CounterpartyAccountSelectorProps {
  accounts: CounterpartyAccount[];
  value: string | null;
  onChange: (accountId: string) => void;
  isLoading?: boolean;
  disabled?: boolean;
}

export function CounterpartyAccountSelector({
  accounts,
  value,
  onChange,
  isLoading,
  disabled,
}: CounterpartyAccountSelectorProps) {
  const t = useTranslations();
  const options = useMemo(
    () =>
      accounts.map((account) => {
        const address = typeof account.details.address === "string" ? account.details.address : "";
        return {
          value: account.id,
          label: account.label ?? address,
          description: account.label ? address : undefined,
        };
      }),
    [accounts]
  );

  return (
    <Combobox
      label={t("DashboardPayments.ramps.destinationAccount")}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={
        disabled
          ? t("DashboardPayments.ramps.selectCounterpartyFirst")
          : options.length === 0
            ? t("DashboardPayments.ramps.noSolanaAccounts")
            : t("DashboardPayments.ramps.selectDestinationAccount")
      }
      searchPlaceholder={t("DashboardPayments.ramps.searchAccounts")}
      icon={<WalletIcon className="size-5 shrink-0 text-tertiary" />}
      isLoading={isLoading}
      disabled={disabled || options.length === 0}
    />
  );
}
