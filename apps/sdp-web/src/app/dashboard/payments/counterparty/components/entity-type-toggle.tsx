"use client";

import { COUNTERPARTY_ENTITY_TYPES, type CounterpartyEntityType } from "@sdp/types";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface EntityTypeToggleProps {
  value: CounterpartyEntityType;
  onChange: (next: CounterpartyEntityType) => void;
}

export function EntityTypeToggle({ value, onChange }: EntityTypeToggleProps) {
  return (
    <div className="space-y-2">
      <Label>Entity type</Label>
      <div className="flex overflow-hidden rounded-md border border-border-light">
        {COUNTERPARTY_ENTITY_TYPES.map((type, i) => (
          <button
            key={type}
            type="button"
            onClick={() => onChange(type)}
            className={cn(
              "flex-1 py-2.5 text-sm font-medium capitalize transition-colors",
              i > 0 && "border-l border-border-light",
              value === type
                ? "bg-gray-1400 text-white"
                : "bg-white text-text-medium hover:bg-border-extra-light hover:text-text-extra-high"
            )}
          >
            {type}
          </button>
        ))}
      </div>
    </div>
  );
}
