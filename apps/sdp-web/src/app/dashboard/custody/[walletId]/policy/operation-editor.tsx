"use client";

import type { WalletOperationFamily } from "@sdp/types";
import { Check } from "lucide-react";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  AUTHORING_RULE_ACTIONS,
  type AuthoringRuleAction,
  type PolicyAuthoringState,
  WALLET_OPERATION_FAMILIES,
} from "./wallet-policy-authoring";
import {
  FAMILY_DESCRIPTION_KEYS,
  FAMILY_LABEL_KEYS,
  FormSection,
  RULE_ACTION_LABEL_KEYS,
} from "./wallet-policy-flow.shared";

export function OperationEditor({
  state,
  error,
  setPolicyState,
}: {
  state: PolicyAuthoringState;
  error?: "invalid_operation_type";
  setPolicyState: (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => void;
}) {
  const t = useTranslations();

  function toggleFamily(family: WalletOperationFamily) {
    setPolicyState((current) => {
      const nextActions = { ...current.familyActions };
      if (nextActions[family]) delete nextActions[family];
      else nextActions[family] = "deny";
      return { ...current, familyActions: nextActions };
    });
  }

  return (
    <FormSection title={t("DashboardCustody.policyOperationControls")}>
      <div className="divide-y divide-border-default border-t border-border-default">
        {WALLET_OPERATION_FAMILIES.map((family) => {
          const action = state.familyActions[family];
          return (
            <div key={family} className="flex min-h-[60px] items-center gap-3 py-2.5 last:pb-0">
              <button
                type="button"
                aria-label={t(FAMILY_LABEL_KEYS[family])}
                aria-pressed={Boolean(action)}
                onClick={() => toggleFamily(family)}
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded border",
                  action
                    ? "border-primary bg-primary text-on-primary"
                    : "border-border-strong bg-surface-raised text-transparent"
                )}
              >
                <Check className="size-3.5" />
              </button>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-medium text-primary">
                  {t(FAMILY_LABEL_KEYS[family])}
                </span>
                <span className="block text-sm text-muted">
                  {t(FAMILY_DESCRIPTION_KEYS[family])}
                </span>
              </span>
              {action ? (
                <Select
                  ariaLabel={t(FAMILY_LABEL_KEYS[family])}
                  value={action}
                  onValueChange={(value) => {
                    if (!value) return;
                    setPolicyState((current) => ({
                      ...current,
                      familyActions: {
                        ...current.familyActions,
                        [family]: value as AuthoringRuleAction,
                      },
                    }));
                  }}
                  className="w-48"
                >
                  {AUTHORING_RULE_ACTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(RULE_ACTION_LABEL_KEYS[option])}
                    </SelectItem>
                  ))}
                </Select>
              ) : null}
            </div>
          );
        })}
      </div>

      {error ? (
        <p className="mt-3 text-sm text-error">
          {t("DashboardCustody.policyOperationTypeTooLong")}
        </p>
      ) : null}
    </FormSection>
  );
}
