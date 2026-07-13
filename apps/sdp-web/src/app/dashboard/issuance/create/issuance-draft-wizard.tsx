"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { AnimatePresence } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { createAssetDraftAction } from "./actions";
import { ClassificationInfoRail } from "./classification-info-rail";
import { CreateDraftConfirmDialog } from "./create-draft-confirm-dialog";
import {
  buildIssuanceMetadata,
  buildTokenInput,
  getAssetDetailsErrors,
  getBlockers,
} from "./draft-mapping";
import { DraftSummaryRail } from "./draft-summary-rail";
import { canAdvance, type WizardStep } from "./issuance-draft-wizard.types";
import { StepAssetDetails } from "./steps/step-asset-details";
import { StepClassification } from "./steps/step-classification";
import { StepPublicInfo } from "./steps/step-public-info";
import { StepReview } from "./steps/step-review";
import { IssuanceDraftProvider, useIssuanceDraft } from "./use-issuance-draft";
import { WizardProgress } from "./wizard-progress";

const ISSUANCE_OVERVIEW_PATH = "/dashboard/issuance";

// Enter advances the wizard from anywhere on the page, EXCEPT when the focused
// control owns Enter itself: text areas (newline), dropdowns/menus (open/select),
// links (navigate), <summary> (toggle), and action buttons (Add / Remove / tabs /
// Back — their own click). Selection cards opt back in via [data-enter-advance]
// because re-selecting the current card is a no-op, so Enter still advances right
// after a card is picked.
function ignoresEnterToAdvance(el: HTMLElement): boolean {
  if (el.closest("[data-enter-advance]")) {
    return false;
  }
  if (el.isContentEditable) {
    return true;
  }
  const tag = el.tagName;
  if (
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "A" ||
    tag === "SUMMARY" ||
    tag === "BUTTON"
  ) {
    return true;
  }
  const role = el.getAttribute("role");
  if (
    role === "button" ||
    role === "combobox" ||
    role === "listbox" ||
    role === "option" ||
    role === "menu" ||
    role === "menuitem"
  ) {
    return true;
  }
  return el.getAttribute("aria-haspopup") !== null;
}

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
  signerWallets: PaymentsDashboardWallet[],
  signerWalletsError: string | null,
  showErrors: boolean
) {
  switch (step) {
    case "classification":
      return <StepClassification />;
    case "asset-details":
      return (
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
  const t = useTranslations();
  const router = useRouter();
  const { draft, currentStep, updatedAt, advance, goBack, reset, clearStoredDraft } =
    useIssuanceDraft();
  const [submitting, setSubmitting] = useState(false);
  // Gates the Create-draft action behind a confirmation dialog, so it never
  // fires from a stray Enter or an accidental click.
  const [confirmOpen, setConfirmOpen] = useState(false);
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
  const blockers = getBlockers(draft, t);

  // Reset the attempt flag whenever the step changes, so each step starts clean
  // and only reveals errors after its own failed Continue.
  // biome-ignore lint/correctness/useExhaustiveDependencies: step is the reset trigger, not a value read in the effect.
  useEffect(() => {
    setAttemptedAdvance(false);
  }, [currentStep]);

  // On the Asset-details form, Continue stays enabled until the user attempts to
  // advance with validation errors — then it locks (and the fields highlight)
  // until every error is resolved. Every other step keeps the coarse gate.
  const isDetailsForm = currentStep === "asset-details";
  const detailsErrorCount = Object.keys(getAssetDetailsErrors(draft, t)).length;
  const canContinue = isDetailsForm
    ? !(attemptedAdvance && detailsErrorCount > 0)
    : canAdvance(currentStep, draft);

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
    const toastId = toast.loading(t("DashboardIssuance.wizard.creatingDraft"), {
      position: "bottom-right",
    });
    try {
      const result = await createAssetDraftAction({
        token: buildTokenInput(draft),
        assetCategory: draft.assetCategory,
        assetType: draft.assetType,
        issuanceMetadata: buildIssuanceMetadata(draft),
      });
      if (result.state === "success") {
        toast.success(t("DashboardIssuance.wizard.draftCreated"), {
          id: toastId,
          position: "bottom-right",
        });
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
      // Failure keeps the user on Review with the error toast — close the
      // confirmation so they can fix things and retry.
      setConfirmOpen(false);
      toast.error(result.message, { id: toastId, position: "bottom-right" });
    } catch (error) {
      setConfirmOpen(false);
      toast.error(
        error instanceof Error ? error.message : t("DashboardIssuance.wizard.failedToCreate"),
        {
          id: toastId,
          position: "bottom-right",
        }
      );
    } finally {
      setSubmitting(false);
    }
  };

  const primaryLabel = isReview
    ? isBusy
      ? t("DashboardIssuance.wizard.creating")
      : t("DashboardIssuance.create.createDraft")
    : t("DashboardIssuance.create.continue");
  const primaryDisabled = isReview ? blockers.length > 0 || isBusy : !canContinue;

  // The footer/rail primary action: on Review, open the create confirmation;
  // otherwise advance to the next step.
  const handlePrimary = () => {
    if (primaryDisabled) {
      return;
    }
    if (isReview) {
      setConfirmOpen(true);
      return;
    }
    handleAdvance();
  };

  const enterAdvanceRef = useRef<() => void>(() => {});
  enterAdvanceRef.current = () => {
    if (confirmOpen) {
      return;
    }
    handlePrimary();
  };
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "Enter" ||
        event.repeat ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        event.defaultPrevented
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && ignoresEnterToAdvance(target)) {
        return;
      }
      // No preventDefault: there is no form to submit, and for a focused selection
      // card we want its native Enter→click (to select) to still fire alongside
      // advancing. Re-selecting the current card is a no-op, so this is safe.
      enterAdvanceRef.current();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-2 pb-6 md:px-6">
        <div className="mx-auto w-full max-w-6xl">
          <WizardProgress currentStep={currentStep} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        <div className="mx-auto w-full max-w-6xl pb-8">
          {/* On Review the header spans the full width above the grid so the
              Summary rail top-aligns with the first section card, not the header. */}
          {isReview ? (
            <div className="mb-5">
              <h2 className="text-2xl font-medium text-primary">
                {t("DashboardIssuance.wizard.reviewAndFinish")}
              </h2>
              <p className="mt-1.5 text-sm text-secondary">
                {t("DashboardIssuance.wizard.reviewDescription")}
              </p>
            </div>
          ) : null}
          <div className={showRail ? "grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]" : undefined}>
            <div className="min-w-0">
              <AnimatePresence mode="wait">
                {renderStep(currentStep, signerWallets, signerWalletsError, attemptedAdvance)}
              </AnimatePresence>
            </div>
            {isClassification ? <ClassificationInfoRail /> : null}
            {showSummaryRail ? (
              <div className={isReview ? undefined : "hidden lg:block"}>
                {/* On Review the rail surfaces blockers / readiness state, so it
                    must stay visible below `lg` too — only the Asset-details
                    step's summary card hides on small screens. */}
                <DraftSummaryRail
                  draft={draft}
                  updatedAt={updatedAt}
                  review={isReview ? { blockers } : undefined}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-border-default bg-white/80 px-4 py-4 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={isClassification ? handleCancel : goBack}
            disabled={isBusy}
          >
            {isClassification
              ? t("DashboardIssuance.workspace.cancel")
              : t("DashboardIssuance.create.back")}
          </Button>
          {/* Primary action on every step, including "Create draft" on Review. */}
          <Button type="button" onClick={handlePrimary} disabled={primaryDisabled}>
            {primaryLabel}
          </Button>
        </div>
      </div>

      <CreateDraftConfirmDialog
        open={confirmOpen}
        assetName={draft.name}
        submitting={isBusy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleSubmit}
      />
    </div>
  );
}
