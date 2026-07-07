"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { AnimatePresence } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createAssetDraftAction } from "./actions";
import { ClassificationInfoRail } from "./classification-info-rail";
import {
  buildIssuanceMetadata,
  buildTokenInput,
  getAssetDetailsErrors,
  getBlockers,
} from "./draft-mapping";
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

interface IssuanceDraftWizardProps {
  signerWallets: PaymentsDashboardWallet[];
  signerWalletsError: string | null;
}

export function IssuanceDraftWizard({
  signerWallets,
  signerWalletsError,
}: IssuanceDraftWizardProps) {
  return (
    <IssuanceDraftProvider>
      <WizardShell signerWallets={signerWallets} signerWalletsError={signerWalletsError} />
    </IssuanceDraftProvider>
  );
}

function renderStep(
  step: WizardStep,
  detailsStage: DetailsStage,
  signerWallets: PaymentsDashboardWallet[],
  signerWalletsError: string | null,
  showErrors: boolean
) {
  switch (step) {
    case "classification":
      return <StepClassification />;
    case "asset-details":
      return detailsStage === "select" ? (
        <StepSubAssetType />
      ) : (
        <StepAssetDetails
          signerWallets={signerWallets}
          signerWalletsError={signerWalletsError}
          showErrors={showErrors}
        />
      );
    case "public-info":
      return <StepPublicInfo />;
    case "review":
      return <StepReview />;
    default:
      return null;
  }
}

function WizardShell({ signerWallets, signerWalletsError }: IssuanceDraftWizardProps) {
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
    clearStoredDraft,
  } = useIssuanceDraft();
  const [submitting, setSubmitting] = useState(false);
  // Keeps the wizard mounted on the Review step while the management page loads
  // after a successful submit, so the form never visibly snaps back to step 1.
  const [isNavigating, startNavigation] = useTransition();
  // Set when the user tries to advance past the Asset-details form with errors:
  // flips the form into "show all errors" mode and locks Continue until fixed.
  const [attemptedAdvance, setAttemptedAdvance] = useState(false);
  // Busy through both the create request and the post-submit navigation, so the
  // action stays locked and in its loading state until the management page shows.
  const isBusy = submitting || isNavigating;

  const isClassification = currentStep === "classification";
  const isReview = currentStep === "review";
  const showSummaryRail = currentStep === "asset-details" || isReview;
  const showRail = isClassification || showSummaryRail;
  const blockers = getBlockers(draft);

  // Reset the attempt flag whenever the step or sub-stage changes, so each step
  // starts clean and only reveals errors after its own failed Continue.
  // biome-ignore lint/correctness/useExhaustiveDependencies: step/sub-stage are the reset triggers, not values read in the effect.
  useEffect(() => {
    setAttemptedAdvance(false);
  }, [currentStep, detailsStage]);

  // On the Asset-details form, Continue stays enabled until the user attempts to
  // advance with validation errors — then it locks (and the fields highlight)
  // until every error is resolved. Every other step keeps the coarse gate.
  const isDetailsForm = currentStep === "asset-details" && detailsStage === "form";
  const detailsErrorCount = Object.keys(getAssetDetailsErrors(draft)).length;
  const canContinue = isDetailsForm
    ? !(attemptedAdvance && detailsErrorCount > 0)
    : canAdvance(currentStep, detailsStage, draft);

  const handleCancel = () => {
    reset();
    router.push(ISSUANCE_OVERVIEW_PATH);
  };

  const handleAdvance = () => {
    // A failed attempt on the details form reveals the field errors and blocks
    // navigation instead of silently no-oping; otherwise advance normally.
    if (isDetailsForm && detailsErrorCount > 0) {
      setAttemptedAdvance(true);
      return;
    }
    advance();
  };

  const handleSubmit = async () => {
    if (blockers.length > 0 || isBusy || !draft.assetCategory || !draft.assetType) {
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
      });
      if (result.state === "success") {
        toast.success("Asset draft created.", { id: toastId, position: "bottom-right" });
        // Wipe the persisted draft now, but leave the in-memory step untouched so
        // the wizard keeps rendering Review. The transition holds this page on
        // screen until the management page has loaded, then it unmounts — so the
        // reset is effectively invisible instead of flashing step 1 mid-load.
        //
        // The write is a single DB transaction, so success means the draft exists
        // even when the response omits the token id — clear the stored draft
        // regardless (so a retry can't duplicate it) and deep-link when we have an
        // id, otherwise fall back to the overview where the new draft is listed.
        clearStoredDraft();
        startNavigation(() => {
          router.push(
            result.tokenId ? `${ISSUANCE_OVERVIEW_PATH}/${result.tokenId}` : ISSUANCE_OVERVIEW_PATH
          );
        });
        return;
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

  const primaryLabel = isReview ? (isBusy ? "Creating…" : "Create draft") : "Continue";
  const primaryDisabled = isReview ? blockers.length > 0 || isBusy : !canContinue;

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
          <AnimatePresence mode="wait">
            {renderStep(
              currentStep,
              detailsStage,
              signerWallets,
              signerWalletsError,
              attemptedAdvance
            )}
          </AnimatePresence>
        </div>
        {isClassification ? <ClassificationInfoRail /> : null}
        {showSummaryRail ? (
          <DraftSummaryRail
            draft={draft}
            updatedAt={updatedAt}
            review={
              isReview
                ? {
                    blockers,
                    submitting: isBusy,
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
          disabled={isBusy}
        >
          {isClassification ? "Cancel" : "Back"}
        </Button>
        {/* On Review the primary action lives in the summary rail (per sketch). */}
        {isReview ? null : (
          <Button type="button" onClick={handleAdvance} disabled={primaryDisabled}>
            {primaryLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
