"use client";

import type { CounterpartyAccount } from "@sdp/types";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import { Combobox } from "@/components/ui/combobox";

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
  const options = useMemo(
    () =>
      accounts.map((account) => {
        const address = typeof account.details.address === "string" ? account.details.address : "";
        return {
          value: account.id,
          label: account.label ?? shortenAddress(address),
          description: shortenAddress(address),
        };
      }),
    [accounts]
  );

  return (
    <Combobox
      label="Destination account"
      value={value}
      onChange={onChange}
      options={options}
      placeholder={
        disabled
          ? "Select a counterparty first"
          : options.length === 0
            ? "No Solana accounts on file"
            : "Select a destination account"
      }
      searchPlaceholder="Search accounts"
      icon={<WalletIcon className="size-5 shrink-0 text-text-low" />}
      isLoading={isLoading}
      disabled={disabled || options.length === 0}
    />
  );
}
