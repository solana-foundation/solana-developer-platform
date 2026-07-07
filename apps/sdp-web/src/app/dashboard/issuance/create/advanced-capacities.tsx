"use client";

import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { CAPACITY_META } from "./asset-details-config";
import { CAPACITY_KEYS, type CapacityKey } from "./issuance-draft-wizard.types";

interface AdvancedCapacitiesProps {
  value: Record<CapacityKey, boolean>;
  onChange: (key: CapacityKey, checked: boolean) => void;
  disabled?: boolean;
}

// Collapsible "Advanced (Recommended)" panel — capacity checkboxes pre-selected
// based on the chosen asset profile (see getRecommendedCapacities). Not a tab.
export function AdvancedCapacities({
  value,
  onChange,
  disabled,
}: AdvancedCapacitiesProps) {
  return (
    <details
      className="group rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-4"
      open
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-semibold text-[#1c1c1d]">Advanced</span>
        <span className="rounded-full bg-[rgba(28,28,29,0.06)] px-2 py-0.5 text-xs font-medium text-[rgba(28,28,29,0.6)]">
          Recommended
        </span>
        <ChevronDown className="ml-auto h-4 w-4 text-[rgba(28,28,29,0.5)] transition-transform group-open:rotate-180" />
      </summary>
      <p className="mt-2 text-sm text-[rgba(28,28,29,0.58)]">
        Recommended capacities are pre-selected based on the asset profile.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {CAPACITY_KEYS.map((key) => {
          const meta = CAPACITY_META[key];
          const checked = value[key];
          return (
            <label
              key={key}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
                checked
                  ? "border-[#1c1c1d] bg-[rgba(28,28,29,0.03)]"
                  : "border-[rgba(28,28,29,0.12)] bg-white hover:bg-[rgba(28,28,29,0.02)]",
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onChange(key, event.currentTarget.checked)}
                className="mt-0.5 h-4 w-4 accent-[#1c1c1d]"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[#1c1c1d]">
                  {meta.label}
                </span>
                <span className="block text-xs text-[rgba(28,28,29,0.58)]">
                  {meta.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </details>
  );
}
