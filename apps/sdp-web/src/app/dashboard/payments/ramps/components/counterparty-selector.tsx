"use client";

import type { Counterparty } from "@sdp/types";
import { PlusIcon, UsersIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";

interface CounterpartySelectorProps {
  counterpartiesResult: { ok: boolean; data: Counterparty[]; error?: string };
  value: string | null;
  onChange: (counterpartyId: string) => void;
  onCreateNew?: () => void;
}

export function CounterpartySelector({
  counterpartiesResult,
  value,
  onChange,
  onCreateNew,
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
      footer={
        onCreateNew
          ? (close) => (
              <button
                type="button"
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-text-extra-high transition-colors hover:bg-[var(--select-item-highlight-bg)]"
                onClick={() => {
                  close();
                  onCreateNew();
                }}
              >
                <PlusIcon className="size-4 shrink-0" />
                Add new counterparty
              </button>
            )
          : undefined
      }
    />
  );
}
