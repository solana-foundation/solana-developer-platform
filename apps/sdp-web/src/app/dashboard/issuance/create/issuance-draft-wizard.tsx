"use client";

import { AnimatePresence } from "motion/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DraftSummaryRail } from "./draft-summary-rail";
import { isStepComplete, type WizardStep } from "./issuance-draft-wizard.types";
import { StepClassification } from "./steps/step-classification";
import { StepPublicInfo } from "./steps/step-public-info";
import { StepReview } from "./steps/step-review";
import { StepSubAssetType } from "./steps/step-sub-asset-type";
import { IssuanceDraftProvider, useIssuanceDraft } from "./use-issuance-draft";
import { WizardProgress } from "./wizard-progress";

const ISSUANCE_OVERVIEW_PATH = "/dashboard/issuance";

export function IssuanceDraftWizard() {
  return (
    <IssuanceDraftProvider>
      <WizardShell />
    </IssuanceDraftProvider>
  );
}

function renderStep(step: WizardStep) {
  switch (step) {
    case "classification":
      return <StepClassification />;
    case "asset-details":
      return <StepSubAssetType />;
    case "public-info":
      return <StepPublicInfo />;
    case "review":
      return <StepReview />;
    default:
      return null;
  }
}

function WizardShell() {
  const router = useRouter();
  const { draft, currentStep, maxStepReached, updatedAt, next, back, goToStep, reset } =
    useIssuanceDraft();

  const isFirstStep = currentStep === "classification";
  const isReview = currentStep === "review";
  const showRail = !isFirstStep;
  const canContinue = isStepComplete(currentStep, draft);

  const handleCancel = () => {
    reset();
    router.push(ISSUANCE_OVERVIEW_PATH);
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-10 md:px-6">
      <div className="pt-2 pb-8">
        <WizardProgress
          currentStep={currentStep}
          maxStepReached={maxStepReached}
          onStepClick={goToStep}
        />
      </div>

      <div className={showRail ? "grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]" : undefined}>
        <div className="min-w-0">
          <AnimatePresence mode="wait">{renderStep(currentStep)}</AnimatePresence>
        </div>
        {showRail ? <DraftSummaryRail draft={draft} updatedAt={updatedAt} /> : null}
      </div>

      <div className="mt-10 flex items-center justify-between gap-3 border-t border-[rgba(28,28,29,0.1)] pt-5">
        <Button type="button" variant="secondary" onClick={isFirstStep ? handleCancel : back}>
          {isFirstStep ? "Cancel" : "Back"}
        </Button>
        <Button type="button" onClick={next} disabled={!canContinue}>
          {isReview ? "Create draft" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
