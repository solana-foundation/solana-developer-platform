"use client";

import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { stepIndex, WIZARD_STEP_META, type WizardStep } from "./issuance-draft-wizard.types";

interface WizardProgressProps {
  currentStep: WizardStep;
}

// Mirrors the Payments wizard progress indicator (RampWizardShell / StepIndicator):
// a compact row of dashes plus a "Step X of Y" caption. The dashes are passive —
// back/forward navigation is driven by the footer controls, matching Payments.
export function WizardProgress({ currentStep }: WizardProgressProps) {
  const t = useTranslations();
  const currentIdx = stepIndex(currentStep);

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        {WIZARD_STEP_META.map((step, index) => (
          <div
            key={step.id}
            className={cn(
              "h-1.5 rounded-full transition-all duration-200",
              index === currentIdx
                ? "w-4 bg-gray-1400"
                : index < currentIdx
                  ? "w-1.5 bg-gray-1400"
                  : "w-1.5 bg-border-light"
            )}
          />
        ))}
      </div>
      <span className="text-xs text-text-extra-low">
        {t("DashboardIssuance.wizard.stepOf", {
          current: currentIdx + 1,
          total: WIZARD_STEP_META.length,
        })}
      </span>
    </div>
  );
}
