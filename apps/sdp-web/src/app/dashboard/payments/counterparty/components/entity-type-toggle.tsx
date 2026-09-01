"use client";

import { COUNTERPARTY_ENTITY_TYPES, type CounterpartyEntityType } from "@sdp/types";
import { Building2Icon, UserIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useTranslations } from "@/i18n/provider";
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
  const t = useTranslations();

  return (
    <div className="flex shrink-0 gap-1 rounded-lg bg-fill-subtle p-1">
      {COUNTERPARTY_ENTITY_TYPES.map((type) => {
        const Icon = ENTITY_ICONS[type];
        const active = value === type;
        return (
          <button
            key={type}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(type)}
            className={cn(
              "flex items-center justify-center gap-2 rounded-md px-3 text-sm font-medium capitalize transition-all",
              active ? "bg-primary text-on-primary shadow-sm" : "text-tertiary hover:text-primary"
            )}
          >
            <Icon className="size-4" />
            {t(`DashboardPayments.counterparty.${type}`)}
          </button>
        );
      })}
    </div>
  );
}
