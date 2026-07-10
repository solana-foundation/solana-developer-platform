"use client";

import { COUNTERPARTY_ENTITY_TYPES, type CounterpartyEntityType } from "@sdp/types";
import { Building2Icon, UserIcon } from "lucide-react";
import type { ComponentType } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface EntityTypeToggleProps {
  value: CounterpartyEntityType;
  onChange: (next: CounterpartyEntityType) => void;
}

const ENTITY_ICONS: Record<CounterpartyEntityType, ComponentType<{ className?: string }>> = {
  individual: UserIcon,
  business: Building2Icon,
};

export function EntityTypeToggle({ value, onChange }: EntityTypeToggleProps) {
  return (
    <div className="space-y-2">
      <Label>Entity type</Label>
      <div className="inline-flex w-full gap-1 rounded-xl bg-fill-subtle p-1">
        {COUNTERPARTY_ENTITY_TYPES.map((type) => {
          const Icon = ENTITY_ICONS[type];
          const active = value === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => onChange(type)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium capitalize transition-all",
                active
                  ? "bg-primary text-white shadow-sm"
                  : "text-tertiary hover:text-primary"
              )}
            >
              <Icon className="size-4" />
              {type}
            </button>
          );
        })}
      </div>
    </div>
  );
}
