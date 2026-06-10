"use client";

import { PlusIcon } from "lucide-react";
import type { CounterpartiesResult } from "../../payments-workspace.data";
import { CounterpartySelector } from "./counterparty-selector";

interface CounterpartyPickerProps {
  mode: "send" | "receive";
  counterpartiesResult: CounterpartiesResult;
  value: string | null;
  onChange: (counterpartyId: string) => void;
  onAddClick: () => void;
}

export function CounterpartyPicker({
  mode,
  counterpartiesResult,
  value,
  onChange,
  onAddClick,
}: CounterpartyPickerProps) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onAddClick}
        className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border-medium px-4 py-4 text-left transition-colors hover:bg-border-extra-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50 dark:focus-visible:ring-white/50"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-border-extra-light text-text-extra-high">
          <PlusIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-text-extra-high">Add counterparty</span>
          <span className="block text-sm text-text-low">
            {mode === "send"
              ? "Create a new payee if they aren't in the list yet."
              : "Create a new buyer if they aren't in the list yet."}
          </span>
        </span>
      </button>
      <CounterpartySelector
        counterpartiesResult={counterpartiesResult}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}
