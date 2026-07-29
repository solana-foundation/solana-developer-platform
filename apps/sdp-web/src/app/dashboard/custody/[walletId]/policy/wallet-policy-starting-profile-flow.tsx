"use client";

import type { PaymentWalletPolicy } from "@sdp/types";
import { ArrowLeft, ArrowRight, MoreHorizontal, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { updateWalletPolicy } from "@/app/dashboard/payments/payments-workspace.data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WizardFrame } from "@/components/wizard-frame";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import { DestinationsAndOperationsStep } from "./destinations-operations-step";
import { DisableControlsDialog } from "./disable-controls-dialog";
import { IntentStep } from "./intent-step";
import { LimitsAndAssetsStep } from "./limits-assets-step";
import type { IssuedPolicyToken } from "./policy-assets.data";
import { PolicySummaryRail } from "./policy-summary-rail";
import { ReviewStep } from "./review-step";
import {
  buildDisabledPolicyPayload,
  buildPolicyAssetOptions,
  buildPolicyPayload,
  clearPolicyDraft,
  createPolicyAuthoringState,
  hasLimitsAndAssetsControls,
  loadPolicyDraft,
  type PolicyFlowStep,
  parseDestinationText,
  policyStateFingerprint,
  type StoredPolicyDraft,
  savePolicyDraft,
  validatePolicyState,
} from "./wallet-policy-authoring";
import {
  FLOW_STEPS,
  hasActiveRestrictions,
  LoadingState,
  type PolicyFlowWallet,
  STEP_COPY,
  type WalletAssetOption,
  walletDetailHref,
} from "./wallet-policy-flow.shared";
import { WalletPolicyToolbar } from "./wallet-policy-toolbar";

interface WalletPolicyStartingProfileFlowProps {
  projectId: string;
  wallet: PolicyFlowWallet;
  walletAssets: WalletAssetOption[];
  issuedTokens: IssuedPolicyToken[];
  initialPolicy: PaymentWalletPolicy;
  policyError: string | null;
  complianceScreeningEnabled: boolean;
}

export function WalletPolicyStartingProfileFlow({
  projectId,
  wallet,
  walletAssets,
  issuedTokens,
  initialPolicy,
  policyError,
  complianceScreeningEnabled,
}: WalletPolicyStartingProfileFlowProps) {
  const t = useTranslations();
  const router = useDashboardRouter();
  const pathname = usePathname();
  const { sdpEnvironment } = useDashboardWorkspace();
  const assetOptions = useMemo(
    () => buildPolicyAssetOptions(walletAssets, sdpEnvironment, issuedTokens),
    [walletAssets, sdpEnvironment, issuedTokens]
  );
  const initialState = useMemo(() => createPolicyAuthoringState(initialPolicy), [initialPolicy]);
  const [state, setState] = useState(initialState);
  const [currentPolicy, setCurrentPolicy] = useState(initialPolicy);
  const [activeFingerprint, setActiveFingerprint] = useState(() =>
    policyStateFingerprint(wallet.walletId, initialState)
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationRequestedSteps, setValidationRequestedSteps] = useState<PolicyFlowStep[]>([]);
  const [disableOpen, setDisableOpen] = useState(false);

  useEffect(() => {
    const draft = loadPolicyDraft(window.localStorage, projectId, wallet.walletId);
    if (draft) {
      setState(draft.state);
      const savedStepIndex = FLOW_STEPS.indexOf(draft.step);
      setStepIndex(
        savedStepIndex === 1 && !hasLimitsAndAssetsControls(draft.state)
          ? 2
          : savedStepIndex < 0
            ? 0
            : savedStepIndex
      );
    }
    setIsLoaded(true);
  }, [projectId, wallet.walletId]);

  const currentStep = FLOW_STEPS[stepIndex] ?? "intent";
  const currentStepCopy = STEP_COPY[currentStep];
  const validation = useMemo(() => validatePolicyState(state), [state]);
  const visibleValidation = validationRequestedSteps.includes(currentStep) ? validation : {};
  const destinationCount = useMemo(
    () =>
      parseDestinationText(state.destinationAllowText).valid.length +
      parseDestinationText(state.destinationBlockText).valid.length,
    [state.destinationAllowText, state.destinationBlockText]
  );
  const stateFingerprint = useMemo(
    () => policyStateFingerprint(wallet.walletId, state),
    [state, wallet.walletId]
  );
  const isDirty = stateFingerprint !== activeFingerprint;

  const createDraft = useCallback(
    (): StoredPolicyDraft => ({
      version: 1,
      projectId,
      walletId: wallet.walletId,
      step: currentStep,
      state,
      updatedAt: new Date().toISOString(),
    }),
    [currentStep, projectId, state, wallet.walletId]
  );

  function persistDraft(notify = false) {
    const draft = createDraft();
    try {
      savePolicyDraft(window.localStorage, draft);
      if (notify) {
        toast.success(t("DashboardCustody.policyDraftSaved"), {
          description: t("DashboardCustody.policyDraftSavedDescription"),
          position: "bottom-right",
        });
      }
    } catch {
      toast.error(t("DashboardCustody.policyDraftSaveFailed"), {
        description: t("DashboardCustody.policyDraftSaveFailedDescription"),
        position: "bottom-right",
      });
    }
  }

  useEffect(() => {
    if (!isLoaded || !isDirty) return;
    const draft = createDraft();
    const timeout = window.setTimeout(() => {
      try {
        savePolicyDraft(window.localStorage, draft);
      } catch {
        // Manual Save draft surfaces storage failures without interrupting editing on every keystroke.
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [createDraft, isDirty, isLoaded]);

  function stepHasErrors(step: PolicyFlowStep): boolean {
    if (step === "intent") return Boolean(validation.intent);
    if (step === "limits-assets") {
      return Boolean(
        validation.maxTransferAmount || validation.maxDailyAmount || validation.assets
      );
    }
    if (step === "destinations-operations") {
      return Boolean(validation.operations);
    }
    return Object.keys(validation).length > 0;
  }

  function goBack() {
    if (stepIndex === 0) {
      router.push(walletDetailHref(pathname, wallet.walletId));
      return;
    }
    if (currentStep === "destinations-operations" && !hasLimitsAndAssetsControls(state)) {
      setStepIndex(0);
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  }

  function goNext() {
    if (stepHasErrors(currentStep)) {
      setValidationRequestedSteps((steps) =>
        steps.includes(currentStep) ? steps : [...steps, currentStep]
      );
      return;
    }
    persistDraft();
    setStepIndex((current) =>
      currentStep === "intent" && !hasLimitsAndAssetsControls(state)
        ? 2
        : Math.min(FLOW_STEPS.length - 1, current + 1)
    );
  }

  async function activateControls() {
    if (Object.keys(validation).length > 0 || policyError || !isDirty) {
      toast.error(t("DashboardCustody.policyActivationValidation"), { position: "bottom-right" });
      return;
    }

    setIsSubmitting(true);
    const toastId = toast.loading(t("DashboardCustody.policyActivating"), {
      position: "bottom-right",
    });
    try {
      const updated = await updateWalletPolicy(
        wallet.walletId,
        buildPolicyPayload(wallet.walletId, state),
        t
      );
      const returnedState = createPolicyAuthoringState(updated);
      setCurrentPolicy(updated);
      setState(returnedState);
      setActiveFingerprint(policyStateFingerprint(wallet.walletId, returnedState));
      clearPolicyDraft(window.localStorage, projectId, wallet.walletId);
      toast.success(t("DashboardCustody.policyActive"), {
        id: toastId,
        description: t("DashboardCustody.policyActiveDescription"),
        position: "bottom-right",
      });
    } catch (error) {
      toast.error(t("DashboardCustody.policyActivationFailed"), {
        id: toastId,
        description:
          error instanceof Error ? error.message : t("DashboardCustody.policySaveFailed"),
        position: "bottom-right",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function disableControls() {
    setIsSubmitting(true);
    const toastId = toast.loading(t("DashboardCustody.policyDisabling"), {
      position: "bottom-right",
    });
    try {
      const updated = await updateWalletPolicy(
        wallet.walletId,
        buildDisabledPolicyPayload(wallet.walletId),
        t
      );
      const returnedState = createPolicyAuthoringState(updated);
      setCurrentPolicy(updated);
      setState(returnedState);
      setActiveFingerprint(policyStateFingerprint(wallet.walletId, returnedState));
      setStepIndex(0);
      clearPolicyDraft(window.localStorage, projectId, wallet.walletId);
      setDisableOpen(false);
      toast.success(t("DashboardCustody.policyDisabled"), {
        id: toastId,
        description: t("DashboardCustody.policyDisabledDescription"),
        position: "bottom-right",
      });
    } catch (error) {
      toast.error(t("DashboardCustody.policyDisableFailed"), {
        id: toastId,
        description:
          error instanceof Error ? error.message : t("DashboardCustody.policySaveFailed"),
        position: "bottom-right",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  const canActivate =
    isDirty && !isSubmitting && !policyError && Object.keys(validation).length === 0;
  const hasActiveControls =
    Boolean(currentPolicy.controlProfile) && hasActiveRestrictions(currentPolicy);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WizardFrame
        steps={FLOW_STEPS.map((step) => ({ label: step, title: t(STEP_COPY[step].titleKey) }))}
        currentStep={stepIndex}
        progressLabel={t("DashboardCustody.stepOf", {
          current: stepIndex + 1,
          total: FLOW_STEPS.length,
        })}
        description={t(currentStepCopy.descriptionKey)}
        maxWidthClassName="max-w-6xl"
        toolbarActions={
          <WalletPolicyToolbar walletHref={walletDetailHref(pathname, wallet.walletId)} />
        }
        aside={
          <PolicySummaryRail
            wallet={wallet}
            policy={currentPolicy}
            state={state}
            stepIndex={stepIndex}
            destinationCount={destinationCount}
            assetOptions={assetOptions}
          />
        }
        footer={
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={goBack}
              disabled={isSubmitting}
              iconLeft={<ArrowLeft className="size-4" />}
            >
              {t("DashboardCustody.back")}
            </Button>

            <div className="flex min-w-0 items-center gap-2">
              {currentStep === "review" ? (
                <>
                  {hasActiveControls ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="secondary"
                          size="icon"
                          aria-label={t("DashboardCustody.policyMoreActions")}
                          disabled={isSubmitting}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem
                          className="text-error focus:bg-error-bg"
                          onSelect={() => setDisableOpen(true)}
                        >
                          <Trash2 className="size-4" />
                          {t("DashboardCustody.policyDisableControls")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => persistDraft(true)}
                    disabled={isSubmitting}
                  >
                    {t("DashboardCustody.policySaveDraft")}
                  </Button>
                  <Button type="button" onClick={activateControls} disabled={!canActivate}>
                    {isSubmitting
                      ? t("DashboardCustody.policyActivating")
                      : isDirty
                        ? t("DashboardCustody.policyActivateControls")
                        : t("DashboardCustody.policyControlsActive")}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  onClick={goNext}
                  disabled={isSubmitting}
                  iconRight={<ArrowRight className="size-4" />}
                >
                  {t("DashboardCustody.continue")}
                </Button>
              )}
            </div>
          </div>
        }
      >
        {policyError ? (
          <div className="mb-5 rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
            {policyError}
          </div>
        ) : null}

        <AnimatePresence mode="wait">
          <motion.div
            key={currentStep}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16 }}
          >
            {!isLoaded ? <LoadingState /> : null}
            {isLoaded && currentStep === "intent" ? (
              <IntentStep
                state={state}
                setPolicyState={setState}
                error={visibleValidation.intent}
              />
            ) : null}
            {isLoaded && currentStep === "limits-assets" ? (
              <LimitsAndAssetsStep
                state={state}
                setPolicyState={setState}
                assetOptions={assetOptions}
                errors={visibleValidation}
              />
            ) : null}
            {isLoaded && currentStep === "destinations-operations" ? (
              <DestinationsAndOperationsStep
                state={state}
                setPolicyState={setState}
                errors={visibleValidation}
                complianceScreeningEnabled={complianceScreeningEnabled}
              />
            ) : null}
            {isLoaded && currentStep === "review" ? (
              <ReviewStep
                state={state}
                assetOptions={assetOptions}
                noRestrictions={Boolean(validation.review)}
                onEdit={(step, category) => {
                  if (category) {
                    setState((current) =>
                      current.categories.includes(category)
                        ? current
                        : { ...current, categories: [...current.categories, category] }
                    );
                  }
                  setStepIndex(FLOW_STEPS.indexOf(step));
                }}
              />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </WizardFrame>

      <DisableControlsDialog
        open={disableOpen}
        walletName={wallet.label || wallet.walletId}
        submitting={isSubmitting}
        onClose={() => setDisableOpen(false)}
        onConfirm={disableControls}
      />
    </div>
  );
}
