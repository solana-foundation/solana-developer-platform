"use client";

import type { CounterpartyAccount } from "@sdp/types";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";

interface CounterpartyAccountSelectorProps {
  accounts: CounterpartyAccount[];
  value: string | null;
  onChange: (accountId: string) => void;
  isLoading?: boolean;
  disabled?: boolean;
}

function shortenAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
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
