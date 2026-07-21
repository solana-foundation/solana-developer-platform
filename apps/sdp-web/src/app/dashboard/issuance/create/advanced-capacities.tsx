"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { CAPACITY_META } from "./asset-details-config";
import { CAPACITY_KEYS, type CapacityKey } from "./issuance-draft-wizard.types";

interface AdvancedCapacitiesProps {
  value: Record<CapacityKey, boolean>;
  onChange: (key: CapacityKey, checked: boolean) => void;
  disabled?: boolean;
}

// Collapsible "Advanced" panel — capacity checkboxes pre-selected based on the
// chosen asset profile (see getRecommendedCapacities). Not a tab.
export function AdvancedCapacities({ value, onChange, disabled }: AdvancedCapacitiesProps) {
  const t = useTranslations();
  return (
    <details className="group rounded-2xl border border-border-default bg-surface-raised p-4" open>
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-semibold text-primary">
          {t("DashboardIssuance.config.advanced")}
        </span>
        <ChevronDown className="ml-auto h-4 w-4 text-tertiary transition-transform group-open:rotate-180" />
      </summary>
      <p className="mt-2 text-sm text-tertiary">
        {t("DashboardIssuance.config.advancedCapacitiesDescription")}
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
                  ? "border-primary bg-fill-subtle"
                  : "border-border-default bg-surface-raised hover:bg-fill-subtle"
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onChange(key, event.currentTarget.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-primary">{t(meta.labelKey)}</span>
                <span className="block text-xs text-tertiary">{t(meta.descriptionKey)}</span>
              </span>
            </label>
          );
        })}
      </div>
    </details>
  );
}
