"use client";

import { Check, ShieldCheck } from "lucide-react";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { AuthoringDefaultAction, PolicyAuthoringState } from "./wallet-policy-authoring";
import {
  CATEGORY_OPTIONS,
  DEFAULT_ACTION_LABEL_KEYS,
  FormSection,
  toggleValue,
} from "./wallet-policy-flow.shared";

export function IntentStep({
  state,
  setPolicyState,
  error,
}: {
  state: PolicyAuthoringState;
  setPolicyState: (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => void;
  error?: "restriction_required";
}) {
  const t = useTranslations();
  return (
    <div className="space-y-6">
      <FormSection
        title={t("DashboardCustody.policyDefaultAction")}
        description={t("DashboardCustody.policyDefaultActionDescription")}
      >
        <Select
          ariaLabel={t("DashboardCustody.policyDefaultAction")}
          value={state.defaultAction}
          onValueChange={(value) => {
            if (!value) return;
            setPolicyState((current) => ({
              ...current,
              defaultAction: value as AuthoringDefaultAction,
            }));
          }}
          size="xl"
          iconLeft={<ShieldCheck />}
        >
          {(Object.keys(DEFAULT_ACTION_LABEL_KEYS) as AuthoringDefaultAction[]).map((action) => (
            <SelectItem key={action} value={action}>
              {t(DEFAULT_ACTION_LABEL_KEYS[action])}
            </SelectItem>
          ))}
        </Select>
      </FormSection>

      <FormSection
        title={t("DashboardCustody.policyRestrictionCategories")}
        description={t("DashboardCustody.policyRestrictionCategoriesDescription")}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {CATEGORY_OPTIONS.map((category) => {
            const selected = state.categories.includes(category.id);
            return (
              <button
                key={category.id}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  setPolicyState((current) => ({
                    ...current,
                    categories: toggleValue(current.categories, category.id),
                  }))
                }
                className={cn(
                  "relative min-h-28 rounded-lg border p-4 pr-12 text-left transition-colors",
                  selected
                    ? "border-primary bg-fill-subtle"
                    : "border-border-default bg-surface-raised hover:bg-surface-sunken"
                )}
              >
                <span className="block text-sm font-semibold text-primary">
                  {t(category.titleKey)}
                </span>
                <span className="mt-1.5 block text-sm leading-5 text-secondary">
                  {t(category.descriptionKey)}
                </span>
                <span
                  className={cn(
                    "absolute top-4 right-4 flex size-5 items-center justify-center rounded border",
                    selected
                      ? "border-primary bg-primary text-on-primary"
                      : "border-border-strong bg-surface-raised text-transparent"
                  )}
                >
                  <Check className="size-3.5" />
                </span>
              </button>
            );
          })}
        </div>
        {error ? (
          <p className="mt-3 text-sm text-error">
            {t("DashboardCustody.policyRestrictionRequired")}
          </p>
        ) : null}
      </FormSection>
    </div>
  );
}
