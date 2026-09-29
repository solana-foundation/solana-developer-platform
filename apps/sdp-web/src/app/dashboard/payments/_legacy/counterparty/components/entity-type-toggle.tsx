"use client";

import { COUNTERPARTY_ENTITY_TYPES, type CounterpartyEntityType } from "@sdp/types";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

interface EntityTypeToggleProps {
  value: CounterpartyEntityType;
  onChange: (next: CounterpartyEntityType) => void;
}

export function EntityTypeToggle({ value, onChange }: EntityTypeToggleProps) {
  const t = useTranslations();

  return (
    <div className="flex shrink-0 gap-0.5 rounded-lg bg-fill-subtle p-1">
      {COUNTERPARTY_ENTITY_TYPES.map((type) => {
        const active = value === type;
        return (
          <button
            key={type}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(type)}
            className={cn(
              "flex items-center rounded-md px-3 text-sm capitalize transition-colors",
              active
                ? "bg-surface-raised font-medium text-primary shadow-sm"
                : "text-tertiary hover:text-secondary"
            )}
          >
            {t(`DashboardPayments.counterparty.${type}`)}
          </button>
        );
      })}
    </div>
  );
}
