"use client";

import { AnimatePresence } from "motion/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createAssetDraftAction } from "./actions";
import { buildIssuanceMetadata, buildTokenInput, getBlockers } from "./draft-mapping";
import { DraftSummaryRail } from "./draft-summary-rail";
import { canAdvance, type DetailsStage, type WizardStep } from "./issuance-draft-wizard.types";
import { StepAssetDetails } from "./steps/step-asset-details";
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

function renderStep(step: WizardStep, detailsStage: DetailsStage) {
  switch (step) {
    case "classification":
      return <StepClassification />;
    case "asset-details":
      return detailsStage === "select" ? <StepSubAssetType /> : <StepAssetDetails />;
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
  const {
    draft,
    currentStep,
    detailsStage,
    maxStepReached,
    updatedAt,
    advance,
    goBack,
    goToStep,
    reset,
  } = useIssuanceDraft();
  const [submitting, setSubmitting] = useState(false);
  const [createdTokenId, setCreatedTokenId] = useState<string | null>(null);

  const isClassification = currentStep === "classification";
  const isReview = currentStep === "review";
  const showRail = currentStep === "asset-details" || isReview;
  const blockers = getBlockers(draft);
  const canContinue = canAdvance(currentStep, detailsStage, draft);

  const handleCancel = () => {
    reset();
    router.push(ISSUANCE_OVERVIEW_PATH);
  };

  const handleSubmit = async () => {
    if (blockers.length > 0 || submitting || !draft.assetCategory || !draft.assetType) {
      return;
    }
    setSubmitting(true);
    const toastId = toast.loading("Creating asset draft…", { position: "bottom-right" });
    try {
      const result = await createAssetDraftAction({
        token: buildTokenInput(draft),
        assetCategory: draft.assetCategory,
        assetType: draft.assetType,
        issuanceMetadata: buildIssuanceMetadata(draft),
        existingTokenId: createdTokenId ?? undefined,
      });
      if (result.state === "success" && result.tokenId) {
        toast.success("Asset draft created.", { id: toastId, position: "bottom-right" });
        reset();
        router.push(`${ISSUANCE_OVERVIEW_PATH}/${result.tokenId}`);
        return;
      }
      // Keep any created tokenId so a retry re-attaches the profile only.
      if (result.tokenId) {
        setCreatedTokenId(result.tokenId);
      }
      toast.error(result.message, { id: toastId, position: "bottom-right" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create draft.", {
        id: toastId,
        position: "bottom-right",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const primaryLabel = isReview
    ? submitting
      ? "Creating…"
      : createdTokenId
        ? "Retry"
        : "Create draft"
    : "Continue";
  const primaryDisabled = isReview ? blockers.length > 0 || submitting : !canContinue;

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
          <AnimatePresence mode="wait">{renderStep(currentStep, detailsStage)}</AnimatePresence>
        </div>
        {showRail ? (
          <DraftSummaryRail
            draft={draft}
            updatedAt={updatedAt}
            review={
              isReview
                ? {
                    blockers,
                    submitting,
                    primaryLabel,
                    disabled: primaryDisabled,
                    onSubmit: handleSubmit,
                  }
                : undefined
            }
          />
        ) : null}
      </div>

      <div className="mt-10 flex items-center justify-between gap-3 border-t border-[rgba(28,28,29,0.1)] pt-5">
        <Button
          type="button"
          variant="secondary"
          onClick={isClassification ? handleCancel : goBack}
          disabled={submitting}
        >
          {isClassification ? "Cancel" : "Back"}
        </Button>
        {/* On Review the primary action lives in the summary rail (per sketch). */}
        {isReview ? null : (
          <Button type="button" onClick={advance} disabled={primaryDisabled}>
            {primaryLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
