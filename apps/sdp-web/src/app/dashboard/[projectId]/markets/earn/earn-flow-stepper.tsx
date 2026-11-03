"use client";

import { WizardStepProgress } from "@sdp/ui/wizard-step-progress";
import { useTranslations } from "@/i18n/provider";

/**
 * Where a deposit or withdrawal is, as the refresh design draws a wizard's progress: the
 * current step's name, "Step x of y" opposite it, and a bar filled to the step beneath.
 * "Step x of y" is the live region, so a step change is announced as the flow advances. It is
 * the dialog's top row, so it stops where the close button starts, as a page wizard's progress
 * stops at its toolbar.
 */
export function EarnFlowStepper({
  currentStep,
  steps,
}: {
  currentStep: number;
  steps: readonly string[];
}) {
  const t = useTranslations();

  return (
    <WizardStepProgress
      className="mr-8 mb-6 refresh:w-auto"
      currentStep={currentStep}
      data-earn-flow-step={steps[currentStep]}
      progressLabel={t("DashboardEarn.deposit.stepProgress", {
        current: currentStep + 1,
        total: steps.length,
      })}
      steps={steps}
    />
  );
}
