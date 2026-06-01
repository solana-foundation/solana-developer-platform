"use client";

import { UsersIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";
import type { CounterpartiesResult } from "../../payments-workspace.data";

interface CounterpartySelectorProps {
  counterpartiesResult: CounterpartiesResult;
  value: string | null;
  onChange: (counterpartyId: string) => void;
}

export function CounterpartySelector({
  counterpartiesResult,
  value,
  onChange,
}: CounterpartySelectorProps) {
  const options = useMemo(
    () =>
      counterpartiesResult.data
        .filter((cp) => cp.status === "active")
        .map((cp) => ({ value: cp.id, label: cp.displayName, description: cp.email })),
    [counterpartiesResult.data]
  );

  return (
    <Combobox
      label="Counterparty"
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Select a counterparty"
      searchPlaceholder="Search counterparties"
      icon={<UsersIcon className="size-5 shrink-0 text-text-low" />}
      error={
        counterpartiesResult.ok
          ? undefined
          : (counterpartiesResult.error ?? "Failed to load counterparties.")
      }
    />
  );
}
