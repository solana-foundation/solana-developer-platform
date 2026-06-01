"use client";

import type { Counterparty } from "@sdp/types";
import { PlusIcon, UsersIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";

interface CounterpartySelectorProps {
  counterparties: Counterparty[];
  value: string | null;
  onChange: (counterpartyId: string) => void;
  onCreateNew?: () => void;
}

export function CounterpartySelector({
  counterparties,
  value,
  onChange,
  onCreateNew,
}: CounterpartySelectorProps) {
  const options = useMemo(
    () =>
      counterparties
        .filter((cp) => cp.status === "active")
        .map((cp) => ({ value: cp.id, label: cp.displayName, description: cp.email })),
    [counterparties]
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
