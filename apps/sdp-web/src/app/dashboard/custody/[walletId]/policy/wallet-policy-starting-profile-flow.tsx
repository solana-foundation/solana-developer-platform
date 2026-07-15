"use client";

import type {
  PaymentWalletPolicy,
  PolicyDefaultAction,
  PolicyProfileStatus,
  WalletOperationFamily,
} from "@sdp/types";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  MoreHorizontal,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { updateWalletPolicy } from "@/app/dashboard/payments/payments-workspace.data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select, SelectItem } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  AUTHORING_RULE_ACTIONS,
  type AuthoringRuleAction,
  buildDisabledPolicyPayload,
  buildPolicyPayload,
  clearPolicyDraft,
  countConfiguredRules,
  createPolicyAuthoringState,
  DESTINATION_MODES,
  formatProviderMappingLabel,
  isProviderMappingWarning,
  isValidSolanaAddress,
  loadPolicyDraft,
  type PolicyAuthoringState,
  type PolicyFlowStep,
  parseDestinationText,
  policyStateFingerprint,
  type RestrictionCategory,
  type StoredPolicyDraft,
  savePolicyDraft,
  validatePolicyState,
  WALLET_OPERATION_FAMILIES,
} from "./wallet-policy-authoring";

interface WalletAssetOption {
  token: string;
  mint: string;
  uiAmount: string;
}

interface WalletPolicyStartingProfileFlowProps {
  projectId: string;
  wallet: {
    walletId: string;
    publicKey: string;
    label: string | null;
    provider: string | null;
  };
  walletAssets: WalletAssetOption[];
  initialPolicy: PaymentWalletPolicy;
  policyError: string | null;
}

const FLOW_STEPS = [
  "intent",
  "limits-assets",
  "destinations-operations",
  "review",
] as const satisfies readonly PolicyFlowStep[];

const CATEGORY_OPTIONS = [
  {
    id: "limits",
    titleKey: "DashboardCustody.policyTransferLimits",
    descriptionKey: "DashboardCustody.policyCategoryLimitsDescription",
  },
  {
    id: "assets",
    titleKey: "DashboardCustody.policyAllowedAssets",
    descriptionKey: "DashboardCustody.policyAllowedAssetsDescription",
  },
  {
    id: "destinations",
    titleKey: "DashboardCustody.policyDestinationControls",
    descriptionKey: "DashboardCustody.policyDestinationControlsDescription",
  },
  {
    id: "operations",
    titleKey: "DashboardCustody.policyOperationControls",
    descriptionKey: "DashboardCustody.policyOperationControlsDescription",
  },
  {
    id: "approvals",
    titleKey: "DashboardCustody.policyApprovalChecks",
    descriptionKey: "DashboardCustody.policyApprovalChecksAuthoringDescription",
  },
] as const satisfies readonly {
  id: RestrictionCategory;
  titleKey: Parameters<ReturnType<typeof useTranslations>>[0];
  descriptionKey: Parameters<ReturnType<typeof useTranslations>>[0];
}[];

const STEP_COPY = {
  intent: {
    titleKey: "DashboardCustody.policyAuthoringIntentTitle",
    descriptionKey: "DashboardCustody.policyAuthoringIntentDescription",
  },
  "limits-assets": {
    titleKey: "DashboardCustody.policyAuthoringLimitsTitle",
    descriptionKey: "DashboardCustody.policyAuthoringLimitsDescription",
  },
  "destinations-operations": {
    titleKey: "DashboardCustody.policyAuthoringDestinationsTitle",
    descriptionKey: "DashboardCustody.policyAuthoringDestinationsDescription",
  },
  review: {
    titleKey: "DashboardCustody.policyAuthoringReviewTitle",
    descriptionKey: "DashboardCustody.policyAuthoringReviewDescription",
  },
} as const;

const DEFAULT_ACTION_LABEL_KEYS = {
  allow: "DashboardCustody.policyDefaultAllow",
  approval_required: "DashboardCustody.policyDefaultApproval",
  review: "DashboardCustody.policyDefaultReview",
  deny: "DashboardCustody.policyDefaultDeny",
} as const satisfies Record<PolicyDefaultAction, Parameters<ReturnType<typeof useTranslations>>[0]>;

const RULE_ACTION_LABEL_KEYS = {
  allow: "DashboardCustody.policyActionAllow",
  deny: "DashboardCustody.policyActionDeny",
  approval_required: "DashboardCustody.policyActionApproval",
  review: "DashboardCustody.policyActionReview",
} as const satisfies Record<AuthoringRuleAction, Parameters<ReturnType<typeof useTranslations>>[0]>;

const FAMILY_LABEL_KEYS = {
  transfer: "DashboardCustody.policyTransfers",
  payment: "DashboardCustody.policyPayments",
  ramp: "DashboardCustody.policyRamps",
  issuance: "DashboardCustody.policyIssuance",
  raw_sign: "DashboardCustody.policyRawSigning",
  program: "DashboardCustody.policyProgramOperations",
  provider_admin: "DashboardCustody.policyProviderAdministration",
} as const satisfies Record<
  WalletOperationFamily,
  Parameters<ReturnType<typeof useTranslations>>[0]
>;

function toggleValue<TValue extends string>(values: TValue[], value: TValue): TValue[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function walletDetailHref(pathname: string, walletId: string): string {
  const section = pathname.startsWith("/dashboard/custody/") ? "custody" : "wallets";
  return `/dashboard/${section}/${encodeURIComponent(walletId)}`;
}

function operationControlCount(state: PolicyAuthoringState): number {
  return (
    Object.values(state.familyActions).filter(Boolean).length + state.operationTypeRules.length
  );
}

function approvalCheckCount(state: PolicyAuthoringState): number {
  return (
    state.approvalFamilies.length +
    Object.values(state.familyActions).filter((action) => action === "approval_required").length +
    state.operationTypeRules.filter((rule) => rule.action === "approval_required").length
  );
}

function hasActiveRestrictions(policy: PaymentWalletPolicy): boolean {
  return Boolean(
    policy.destinationAllowlist.length ||
      policy.maxTransferAmount ||
      policy.maxDailyAmount ||
      policy.rules?.length
  );
}

export function WalletPolicyStartingProfileFlow({
  projectId,
  wallet,
  walletAssets,
  initialPolicy,
  policyError,
}: WalletPolicyStartingProfileFlowProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const initialState = useMemo(() => createPolicyAuthoringState(initialPolicy), [initialPolicy]);
  const [state, setState] = useState(initialState);
  const [currentPolicy, setCurrentPolicy] = useState(initialPolicy);
  const [activeFingerprint, setActiveFingerprint] = useState(() =>
    policyStateFingerprint(wallet.walletId, initialState)
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);

  useEffect(() => {
    const draft = loadPolicyDraft(window.localStorage, projectId, wallet.walletId);
    if (draft) {
      setState(draft.state);
      setLastSavedAt(draft.updatedAt);
      const savedStepIndex = FLOW_STEPS.indexOf(draft.step);
      setStepIndex(savedStepIndex < 0 ? 0 : savedStepIndex);
    }
    setIsLoaded(true);
  }, [projectId, wallet.walletId]);

  const currentStep = FLOW_STEPS[stepIndex] ?? "intent";
  const currentStepCopy = STEP_COPY[currentStep];
  const validation = useMemo(() => validatePolicyState(state), [state]);
  const destinationParse = useMemo(
    () => parseDestinationText(state.destinationText),
    [state.destinationText]
  );
  const stateFingerprint = useMemo(
    () => policyStateFingerprint(wallet.walletId, state),
    [state, wallet.walletId]
  );
  const isDirty = stateFingerprint !== activeFingerprint;

  function createDraft(): StoredPolicyDraft {
    return {
      version: 1,
      projectId,
      walletId: wallet.walletId,
      step: currentStep,
      state,
      updatedAt: new Date().toISOString(),
    };
  }

  function persistDraft(notify = false) {
    const draft = createDraft();
    try {
      savePolicyDraft(window.localStorage, draft);
      setLastSavedAt(draft.updatedAt);
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
    const draft: StoredPolicyDraft = {
      version: 1,
      projectId,
      walletId: wallet.walletId,
      step: currentStep,
      state,
      updatedAt: new Date().toISOString(),
    };
    const timeout = window.setTimeout(() => {
      try {
        savePolicyDraft(window.localStorage, draft);
        setLastSavedAt(draft.updatedAt);
      } catch {
        // Manual Save draft surfaces storage failures without interrupting editing on every keystroke.
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [currentStep, isDirty, isLoaded, projectId, state, wallet.walletId]);

  function setPolicyState(update: (current: PolicyAuthoringState) => PolicyAuthoringState) {
    setState((current) => update(current));
  }

  function stepHasErrors(step: PolicyFlowStep): boolean {
    if (step === "intent") return Boolean(validation.intent);
    if (step === "limits-assets") {
      return Boolean(
        validation.maxTransferAmount || validation.maxDailyAmount || validation.assets
      );
    }
    if (step === "destinations-operations") {
      return Boolean(validation.destinations || validation.operations || validation.approvals);
    }
    return Object.keys(validation).length > 0;
  }

  function goBack() {
    if (stepIndex === 0) {
      router.push(walletDetailHref(pathname, wallet.walletId));
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  }

  function goNext() {
    if (stepHasErrors(currentStep)) return;
    persistDraft();
    setStepIndex((current) => Math.min(FLOW_STEPS.length - 1, current + 1));
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
      setLastSavedAt(null);
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
      setLastSavedAt(null);
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

  const providerMappingLabel = formatProviderMappingLabel(
    currentPolicy.controlProfile?.providerMappingStatus ?? null,
    Boolean(wallet.provider)
  );
  const canActivate =
    isDirty && !isSubmitting && !policyError && Object.keys(validation).length === 0;
  const hasActiveControls =
    Boolean(currentPolicy.controlProfile) && hasActiveRestrictions(currentPolicy);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="shrink-0 border-b border-border-default px-4 py-5 md:px-6">
        <div className="mx-auto w-full max-w-6xl">
          <StepIndicator stepIndex={stepIndex} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
        <div className="mx-auto grid w-full max-w-6xl gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <main className="min-w-0">
            <div className="mb-6">
              <h1 className="text-2xl font-medium text-primary">{t(currentStepCopy.titleKey)}</h1>
              <p className="mt-1.5 max-w-2xl text-sm leading-6 text-secondary">
                {t(currentStepCopy.descriptionKey)}
              </p>
              {lastSavedAt ? (
                <p className="mt-2 text-xs text-muted">
                  {t("DashboardCustody.policyDraftStoredLocally", {
                    date: formatSavedAt(lastSavedAt, locale),
                  })}
                </p>
              ) : null}
            </div>

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
                    setPolicyState={setPolicyState}
                    error={validation.intent}
                  />
                ) : null}
                {isLoaded && currentStep === "limits-assets" ? (
                  <LimitsAndAssetsStep
                    state={state}
                    setPolicyState={setPolicyState}
                    walletAssets={walletAssets}
                    errors={validation}
                  />
                ) : null}
                {isLoaded && currentStep === "destinations-operations" ? (
                  <DestinationsAndOperationsStep
                    state={state}
                    setPolicyState={setPolicyState}
                    destinationParse={destinationParse}
                    errors={validation}
                  />
                ) : null}
                {isLoaded && currentStep === "review" ? (
                  <ReviewStep
                    state={state}
                    providerMappingLabel={providerMappingLabel}
                    onEdit={(step) => setStepIndex(FLOW_STEPS.indexOf(step))}
                  />
                ) : null}
              </motion.div>
            </AnimatePresence>
          </main>

          <PolicySummaryRail
            wallet={wallet}
            policy={currentPolicy}
            state={state}
            destinationCount={destinationParse.valid.length}
            providerMappingLabel={providerMappingLabel}
          />
        </div>
      </div>

      <footer className="shrink-0 border-t border-border-default bg-white/95 px-4 py-4 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
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
                disabled={stepHasErrors(currentStep) || isSubmitting}
                iconRight={<ArrowRight className="size-4" />}
              >
                {t("DashboardCustody.continue")}
              </Button>
            )}
          </div>
        </div>
      </footer>

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

function StepIndicator({ stepIndex }: { stepIndex: number }) {
  const t = useTranslations();
  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {FLOW_STEPS.map((step, index) => (
          <span
            key={step}
            className={cn(
              "h-1.5 rounded-full transition-[width,background-color] duration-200",
              index === stepIndex
                ? "w-5 bg-primary"
                : index < stepIndex
                  ? "w-2.5 bg-primary"
                  : "w-2.5 bg-fill-strong"
            )}
          />
        ))}
      </div>
      <span className="text-xs text-muted">
        {t("DashboardCustody.stepOf", { current: stepIndex + 1, total: FLOW_STEPS.length })}
      </span>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="h-32 animate-pulse rounded-lg bg-surface-sunken" />
      <div className="h-48 animate-pulse rounded-lg bg-surface-sunken" />
    </div>
  );
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border-default bg-white p-5">
      <h2 className="text-base font-semibold text-primary">{title}</h2>
      <p className="mt-1 text-sm leading-5 text-secondary">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function IntentStep({
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
    <div className="space-y-5">
      <FormSection
        title={t("DashboardCustody.policyDefaultAction")}
        description={t("DashboardCustody.policyDefaultActionDescription")}
      >
        <div className="grid rounded-full bg-fill p-1 sm:grid-cols-2 lg:grid-cols-4">
          {(Object.keys(DEFAULT_ACTION_LABEL_KEYS) as PolicyDefaultAction[]).map((action) => (
            <button
              key={action}
              type="button"
              aria-pressed={state.defaultAction === action}
              onClick={() => setPolicyState((current) => ({ ...current, defaultAction: action }))}
              className={cn(
                "min-h-10 rounded-full px-3 text-center text-xs font-semibold transition-colors",
                state.defaultAction === action
                  ? "bg-white text-primary shadow-sm"
                  : "text-secondary hover:text-primary"
              )}
            >
              {t(DEFAULT_ACTION_LABEL_KEYS[action])}
            </button>
          ))}
        </div>
      </FormSection>

      <FormSection
        title={t("DashboardCustody.policyRestrictionCategories")}
        description={t("DashboardCustody.policyIntentDescription")}
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
                    : "border-border-default bg-white hover:bg-surface-sunken"
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
                      ? "border-primary bg-primary text-white"
                      : "border-border-strong bg-white text-transparent"
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

function LimitsAndAssetsStep({
  state,
  setPolicyState,
  walletAssets,
  errors,
}: {
  state: PolicyAuthoringState;
  setPolicyState: (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => void;
  walletAssets: WalletAssetOption[];
  errors: ReturnType<typeof validatePolicyState>;
}) {
  const t = useTranslations();
  const showLimits = state.categories.includes("limits");
  const showAssets = state.categories.includes("assets");

  if (!showLimits && !showAssets) return <EmptyStepState />;

  return (
    <div className="space-y-5">
      {showLimits ? (
        <FormSection
          title={t("DashboardCustody.policyTransferLimits")}
          description={t("DashboardCustody.policyNoGenericLimit")}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <AmountField
              id="policy-per-transaction"
              label={t("DashboardCustody.policyPerTransaction")}
              value={state.maxTransferAmount}
              error={errors.maxTransferAmount}
              onChange={(value) =>
                setPolicyState((current) => ({ ...current, maxTransferAmount: value }))
              }
            />
            <AmountField
              id="policy-daily-total"
              label={t("DashboardCustody.policyDailyTotal")}
              value={state.maxDailyAmount}
              error={errors.maxDailyAmount}
              onChange={(value) =>
                setPolicyState((current) => ({ ...current, maxDailyAmount: value }))
              }
            />
          </div>
        </FormSection>
      ) : null}

      {showAssets ? (
        <AssetEditor
          assets={state.assets}
          walletAssets={walletAssets}
          error={errors.assets}
          onChange={(assets) => setPolicyState((current) => ({ ...current, assets }))}
        />
      ) : null}
    </div>
  );
}

function AmountField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: "invalid_decimal" | "daily_below_transaction";
  onChange: (value: string) => void;
}) {
  const t = useTranslations();
  return (
    <label htmlFor={id} className="block">
      <span className="mb-2 block text-sm font-medium text-primary">{label}</span>
      <Input
        id={id}
        value={value}
        inputMode="decimal"
        placeholder="0.00"
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <span className="mt-2 block text-sm text-error">
          {error === "daily_below_transaction"
            ? t("DashboardCustody.policyDailyBelowTransaction")
            : t("DashboardCustody.policyInvalidDecimal")}
        </span>
      ) : null}
    </label>
  );
}

function AssetEditor({
  assets,
  walletAssets,
  error,
  onChange,
}: {
  assets: string[];
  walletAssets: WalletAssetOption[];
  error?: "asset_required" | "invalid_asset";
  onChange: (assets: string[]) => void;
}) {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const [inputError, setInputError] = useState<"invalid" | "duplicate" | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const uniqueWalletAssets = walletAssets.filter(
    (asset, index, values) => values.findIndex((item) => item.mint === asset.mint) === index
  );
  const matchingWalletAssets = uniqueWalletAssets
    .filter(
      (asset) =>
        !assets.includes(asset.mint) &&
        (!normalizedQuery ||
          asset.token.toLowerCase().includes(normalizedQuery) ||
          asset.mint.toLowerCase().includes(normalizedQuery))
    )
    .slice(0, 5);
  const canAddCustomMint =
    isValidSolanaAddress(query) &&
    !assets.includes(query.trim()) &&
    !matchingWalletAssets.some((asset) => asset.mint === query.trim());

  function addAsset(mint: string) {
    const normalized = mint.trim();
    if (assets.includes(normalized)) {
      setInputError("duplicate");
      return;
    }
    if (!isValidSolanaAddress(normalized)) {
      setInputError("invalid");
      return;
    }
    onChange([...assets, normalized]);
    setQuery("");
    setInputError(null);
  }

  return (
    <FormSection
      title={t("DashboardCustody.policyAllowedAssets")}
      description={t("DashboardCustody.policyAllowedAssetsDescription")}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
        <Input
          value={query}
          className="pl-9"
          placeholder={t("DashboardCustody.policySearchAssets")}
          onChange={(event) => {
            setQuery(event.target.value);
            setInputError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addAsset(query);
            }
          }}
        />
      </div>

      {query.trim() && (matchingWalletAssets.length > 0 || canAddCustomMint) ? (
        <div className="mt-2 overflow-hidden rounded-lg border border-border-default bg-white">
          {matchingWalletAssets.map((asset) => (
            <button
              key={asset.mint}
              type="button"
              className="flex w-full items-center justify-between gap-4 border-b border-border-default px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-sunken"
              onClick={() => addAsset(asset.mint)}
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-primary">{asset.token}</span>
                <span className="block truncate text-xs text-muted">{asset.mint}</span>
              </span>
              <span className="shrink-0 text-xs text-secondary">{asset.uiAmount}</span>
            </button>
          ))}
          {canAddCustomMint ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t border-border-default px-3 py-2.5 text-left text-sm font-medium text-primary hover:bg-surface-sunken first:border-t-0"
              onClick={() => addAsset(query)}
            >
              <Plus className="size-4" />
              {t("DashboardCustody.policyAddCustomMint")}
            </button>
          ) : null}
        </div>
      ) : uniqueWalletAssets.length > 0 ? (
        <div className="mt-3">
          <p className="mb-2 text-xs font-medium text-muted">
            {t("DashboardCustody.policyWalletAssets")}
          </p>
          <div className="flex flex-wrap gap-2">
            {uniqueWalletAssets
              .filter((asset) => !assets.includes(asset.mint))
              .slice(0, 6)
              .map((asset) => (
                <button
                  key={asset.mint}
                  type="button"
                  className="rounded-md border border-border-default bg-white px-3 py-2 text-sm text-primary hover:bg-surface-sunken"
                  onClick={() => addAsset(asset.mint)}
                >
                  {asset.token}
                </button>
              ))}
          </div>
        </div>
      ) : null}

      {inputError ? (
        <p className="mt-2 text-sm text-error">
          {t(
            inputError === "duplicate"
              ? "DashboardCustody.policyDuplicateAsset"
              : "DashboardCustody.policyInvalidMint"
          )}
        </p>
      ) : null}

      {assets.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {assets.map((mint) => {
            const walletAsset = uniqueWalletAssets.find((asset) => asset.mint === mint);
            return (
              <span
                key={mint}
                className="inline-flex max-w-full items-center gap-2 rounded-full bg-fill px-3 py-1.5 text-sm text-primary"
              >
                <span className="max-w-48 truncate">{walletAsset?.token ?? mint}</span>
                <button
                  type="button"
                  className="text-muted hover:text-primary"
                  aria-label={t("DashboardCustody.policyRemoveAsset", {
                    asset: walletAsset?.token ?? mint,
                  })}
                  onClick={() => onChange(assets.filter((asset) => asset !== mint))}
                >
                  <X className="size-3.5" />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 text-sm text-error">
          {t(
            error === "invalid_asset"
              ? "DashboardCustody.policyInvalidMint"
              : "DashboardCustody.policyAssetRequired"
          )}
        </p>
      ) : null}
    </FormSection>
  );
}

function DestinationsAndOperationsStep({
  state,
  setPolicyState,
  destinationParse,
  errors,
}: {
  state: PolicyAuthoringState;
  setPolicyState: (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => void;
  destinationParse: ReturnType<typeof parseDestinationText>;
  errors: ReturnType<typeof validatePolicyState>;
}) {
  const showDestinations = state.categories.includes("destinations");
  const showOperations = state.categories.includes("operations");
  const showApprovals = state.categories.includes("approvals");

  if (!showDestinations && !showOperations && !showApprovals) return <EmptyStepState />;

  return (
    <div className="space-y-5">
      {showDestinations ? (
        <DestinationEditor
          state={state}
          parsed={destinationParse}
          error={errors.destinations}
          setPolicyState={setPolicyState}
        />
      ) : null}
      {showOperations ? (
        <OperationEditor state={state} error={errors.operations} setPolicyState={setPolicyState} />
      ) : null}
      {showApprovals ? (
        <ApprovalEditor
          values={state.approvalFamilies}
          error={errors.approvals}
          onChange={(approvalFamilies) =>
            setPolicyState((current) => ({ ...current, approvalFamilies }))
          }
        />
      ) : null}
    </div>
  );
}

function DestinationEditor({
  state,
  parsed,
  error,
  setPolicyState,
}: {
  state: PolicyAuthoringState;
  parsed: ReturnType<typeof parseDestinationText>;
  error?: "destination_required" | "invalid_destination";
  setPolicyState: (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => void;
}) {
  const t = useTranslations();
  return (
    <FormSection
      title={t("DashboardCustody.policyDestinationControls")}
      description={t("DashboardCustody.policyDestinationControlsDescription")}
    >
      <div className="grid max-w-sm grid-cols-2 rounded-full bg-fill p-1">
        {DESTINATION_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={state.destinationMode === mode}
            className={cn(
              "h-9 rounded-full text-sm font-semibold transition-colors",
              state.destinationMode === mode
                ? "bg-white text-primary shadow-sm"
                : "text-secondary hover:text-primary"
            )}
            onClick={() => setPolicyState((current) => ({ ...current, destinationMode: mode }))}
          >
            {t(
              mode === "allowlist"
                ? "DashboardCustody.policyAllowList"
                : "DashboardCustody.policyBlockList"
            )}
          </button>
        ))}
      </div>
      <label className="mt-5 block" htmlFor="policy-destinations">
        <span className="mb-2 block text-sm font-medium text-primary">
          {t("DashboardCustody.policyWalletAddresses")}
        </span>
        <textarea
          id="policy-destinations"
          rows={7}
          value={state.destinationText}
          onChange={(event) =>
            setPolicyState((current) => ({ ...current, destinationText: event.target.value }))
          }
          aria-invalid={Boolean(error)}
          className="min-h-40 w-full resize-y rounded-lg border border-border-default bg-white px-3 py-3 text-sm leading-6 text-primary outline-none transition-colors placeholder:text-muted focus:border-primary"
          placeholder={`${"11111111111111111111111111111111"}\n${"So11111111111111111111111111111111111111112"}`}
        />
      </label>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted">{t("DashboardCustody.policyOneAddressPerLine")}</span>
        <span className="font-medium text-secondary">
          {t("DashboardCustody.policyValidAddressCount", { count: parsed.valid.length })}
        </span>
      </div>
      {parsed.invalid.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {parsed.invalid.map((entry) => (
            <p key={`${entry.line}-${entry.value}`} className="text-sm text-error">
              {t("DashboardCustody.policyInvalidAddressLine", {
                line: entry.line,
                address: entry.value,
              })}
            </p>
          ))}
        </div>
      ) : error ? (
        <p className="mt-3 text-sm text-error">{t("DashboardCustody.policyDestinationRequired")}</p>
      ) : null}
    </FormSection>
  );
}

function OperationEditor({
  state,
  error,
  setPolicyState,
}: {
  state: PolicyAuthoringState;
  error?: "operation_required" | "invalid_operation_type";
  setPolicyState: (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => void;
}) {
  const t = useTranslations();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [operationType, setOperationType] = useState("");
  const [operationTypeError, setOperationTypeError] = useState<"duplicate" | "too_long" | null>(
    null
  );

  function toggleFamily(family: WalletOperationFamily) {
    setPolicyState((current) => {
      const nextActions = { ...current.familyActions };
      if (nextActions[family]) delete nextActions[family];
      else nextActions[family] = "deny";
      return { ...current, familyActions: nextActions };
    });
  }

  function addOperationType() {
    const value = operationType.trim();
    if (!value) return;
    if (value.length > 120) {
      setOperationTypeError("too_long");
      return;
    }
    if (state.operationTypeRules.some((entry) => entry.value === value)) {
      setOperationTypeError("duplicate");
      return;
    }
    setPolicyState((current) => ({
      ...current,
      operationTypeRules: [...current.operationTypeRules, { value, action: "deny" }],
    }));
    setOperationType("");
    setOperationTypeError(null);
  }

  return (
    <FormSection
      title={t("DashboardCustody.policyOperationControls")}
      description={t("DashboardCustody.policyOperationControlsDescription")}
    >
      <h3 className="text-sm font-semibold text-primary">
        {t("DashboardCustody.policyOperationFamilies")}
      </h3>
      <div className="mt-3 divide-y divide-border-default border-y border-border-default">
        {WALLET_OPERATION_FAMILIES.map((family) => {
          const action = state.familyActions[family];
          return (
            <div key={family} className="flex min-h-14 items-center gap-3 py-2.5">
              <button
                type="button"
                aria-label={t(FAMILY_LABEL_KEYS[family])}
                aria-pressed={Boolean(action)}
                onClick={() => toggleFamily(family)}
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded border",
                  action
                    ? "border-primary bg-primary text-white"
                    : "border-border-strong bg-white text-transparent"
                )}
              >
                <Check className="size-3.5" />
              </button>
              <span className="min-w-0 flex-1 text-sm font-medium text-primary">
                {t(FAMILY_LABEL_KEYS[family])}
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

      <div className="mt-5 border-t border-border-default pt-1">
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((current) => !current)}
          className="flex w-full items-center justify-between gap-3 py-3 text-left"
        >
          <span>
            <span className="block text-sm font-semibold text-primary">
              {t("DashboardCustody.policyAdvancedOperationTypes")}
            </span>
            <span className="mt-1 block text-sm leading-5 text-secondary">
              {t("DashboardCustody.policyAdvancedOperationDescription")}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted transition-transform",
              advancedOpen && "rotate-180"
            )}
          />
        </button>
        {advancedOpen ? (
          <div className="pb-1">
            <div className="flex gap-2">
              <Input
                value={operationType}
                maxLength={121}
                placeholder={t("DashboardCustody.policyOperationTypePlaceholder")}
                onChange={(event) => {
                  setOperationType(event.target.value);
                  setOperationTypeError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addOperationType();
                  }
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label={t("DashboardCustody.policyAddOperationType")}
                onClick={addOperationType}
              >
                <Plus className="size-4" />
              </Button>
            </div>
            {operationTypeError ? (
              <p className="mt-2 text-sm text-error">
                {t(
                  operationTypeError === "duplicate"
                    ? "DashboardCustody.policyOperationTypeDuplicate"
                    : "DashboardCustody.policyOperationTypeTooLong"
                )}
              </p>
            ) : null}
            {state.operationTypeRules.length > 0 ? (
              <div className="mt-3 divide-y divide-border-default rounded-lg border border-border-default">
                {state.operationTypeRules.map((entry) => (
                  <div key={entry.value} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-sm text-primary">
                      {entry.value}
                    </span>
                    <Select
                      value={entry.action}
                      onValueChange={(value) => {
                        if (!value) return;
                        setPolicyState((current) => ({
                          ...current,
                          operationTypeRules: current.operationTypeRules.map((item) =>
                            item.value === entry.value
                              ? { ...item, action: value as AuthoringRuleAction }
                              : item
                          ),
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("DashboardCustody.policyRemoveOperationType", {
                        operationType: entry.value,
                      })}
                      onClick={() =>
                        setPolicyState((current) => ({
                          ...current,
                          operationTypeRules: current.operationTypeRules.filter(
                            (item) => item.value !== entry.value
                          ),
                        }))
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="mt-3 text-sm text-error">
          {t(
            error === "invalid_operation_type"
              ? "DashboardCustody.policyOperationTypeTooLong"
              : "DashboardCustody.policyOperationRequired"
          )}
        </p>
      ) : null}
    </FormSection>
  );
}

function ApprovalEditor({
  values,
  error,
  onChange,
}: {
  values: WalletOperationFamily[];
  error?: "approval_required";
  onChange: (values: WalletOperationFamily[]) => void;
}) {
  const t = useTranslations();
  return (
    <FormSection
      title={t("DashboardCustody.policyApprovalChecks")}
      description={t("DashboardCustody.policyApprovalChecksAuthoringDescription")}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {WALLET_OPERATION_FAMILIES.map((family) => {
          const selected = values.includes(family);
          return (
            <button
              key={family}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(toggleValue(values, family))}
              className={cn(
                "flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors",
                selected
                  ? "border-primary bg-fill-subtle text-primary"
                  : "border-border-default bg-white text-secondary hover:bg-surface-sunken"
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded border",
                  selected
                    ? "border-primary bg-primary text-white"
                    : "border-border-strong bg-white text-transparent"
                )}
              >
                <Check className="size-3.5" />
              </span>
              {t(FAMILY_LABEL_KEYS[family])}
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="mt-3 text-sm text-error">
          {t("DashboardCustody.policyApprovalRequiredAuthoring")}
        </p>
      ) : null}
    </FormSection>
  );
}

function EmptyStepState() {
  const t = useTranslations();
  return (
    <div className="rounded-lg border border-border-default bg-surface-sunken px-5 py-8 text-center text-sm text-secondary">
      {t("DashboardCustody.policyNoStepControls")}
    </div>
  );
}

function ReviewStep({
  state,
  providerMappingLabel,
  onEdit,
}: {
  state: PolicyAuthoringState;
  providerMappingLabel: string;
  onEdit: (step: PolicyFlowStep) => void;
}) {
  const t = useTranslations();
  const destinations = parseDestinationText(state.destinationText).valid;
  const limitParts = [
    state.maxTransferAmount
      ? t("DashboardCustody.policyReviewPerTransaction", { amount: state.maxTransferAmount })
      : null,
    state.maxDailyAmount
      ? t("DashboardCustody.policyReviewDailyTotal", { amount: state.maxDailyAmount })
      : null,
  ].filter((value): value is string => Boolean(value));
  const reviewRows = [
    {
      label: t("DashboardCustody.policyDefaultAction"),
      value: t(DEFAULT_ACTION_LABEL_KEYS[state.defaultAction]),
      step: "intent" as const,
    },
    {
      label: t("DashboardCustody.policyReviewTransferLimits"),
      value: limitParts.join(" / "),
      step: "limits-assets" as const,
    },
    {
      label: t("DashboardCustody.policyReviewAllowedAssets"),
      value: state.assets.length
        ? t("DashboardCustody.policyReviewAssetCount", { count: state.assets.length })
        : "",
      step: "limits-assets" as const,
    },
    {
      label: t("DashboardCustody.policyReviewDestinationControls"),
      value: destinations.length
        ? t("DashboardCustody.policyReviewDestinationCount", {
            count: destinations.length,
            mode: t(
              state.destinationMode === "allowlist"
                ? "DashboardCustody.policyAllowList"
                : "DashboardCustody.policyBlockList"
            ).toLowerCase(),
          })
        : "",
      step: "destinations-operations" as const,
    },
    {
      label: t("DashboardCustody.policyReviewOperationControls"),
      value: operationControlCount(state)
        ? t("DashboardCustody.policyReviewOperationCount", {
            count: operationControlCount(state),
          })
        : "",
      step: "destinations-operations" as const,
    },
    {
      label: t("DashboardCustody.policyReviewApprovalChecks"),
      value: approvalCheckCount(state)
        ? t("DashboardCustody.policyReviewApprovalCount", { count: approvalCheckCount(state) })
        : "",
      step: "destinations-operations" as const,
    },
    {
      label: t("DashboardCustody.policyReviewProviderMapping"),
      value: providerMappingLabel,
      step: null,
    },
  ];

  return (
    <div className="overflow-hidden rounded-lg border border-border-default bg-white">
      {reviewRows.map((row) => (
        <div
          key={row.label}
          className="flex items-start justify-between gap-5 border-t border-border-default px-5 py-4 first:border-t-0"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">{row.label}</p>
            <p className="mt-1 text-sm leading-5 text-secondary">
              {row.value || t("DashboardCustody.policyNotConfigured")}
            </p>
          </div>
          {row.step ? (
            <Button type="button" variant="link" size="sm" onClick={() => onEdit(row.step)}>
              {t("DashboardCustody.policyEdit")}
            </Button>
          ) : null}
        </div>
      ))}
      {state.passthroughRules.length > 0 ? (
        <div className="border-t border-border-default bg-surface-sunken px-5 py-3 text-xs text-secondary">
          {t("DashboardCustody.policyReviewPreservedRules", {
            count: state.passthroughRules.length,
          })}
        </div>
      ) : null}
    </div>
  );
}

function PolicySummaryRail({
  wallet,
  policy,
  state,
  destinationCount,
  providerMappingLabel,
}: {
  wallet: WalletPolicyStartingProfileFlowProps["wallet"];
  policy: PaymentWalletPolicy;
  state: PolicyAuthoringState;
  destinationCount: number;
  providerMappingLabel: string;
}) {
  const t = useTranslations();
  const status = policy.controlProfile?.status ?? null;
  const providerStatus = policy.controlProfile?.providerMappingStatus ?? null;
  const warning = isProviderMappingWarning(providerStatus);
  const rows = [
    { label: t("DashboardCustody.policySummaryStatus"), value: formatProfileStatus(status, t) },
    {
      label: t("DashboardCustody.policyRevision"),
      value: policy.controlProfile?.revisionNumber
        ? `#${policy.controlProfile.revisionNumber}`
        : t("DashboardCustody.policyStatusNotActivated"),
    },
    {
      label: t("DashboardCustody.policySummaryDefaultAction"),
      value: t(DEFAULT_ACTION_LABEL_KEYS[state.defaultAction]),
    },
    {
      label: t("DashboardCustody.policySummaryRules"),
      value: String(countConfiguredRules(state)),
    },
    { label: t("DashboardCustody.policySummaryAllowedAssets"), value: String(state.assets.length) },
    { label: t("DashboardCustody.policySummaryDestinations"), value: String(destinationCount) },
    {
      label: t("DashboardCustody.policySummaryApprovals"),
      value: String(approvalCheckCount(state)),
    },
  ];

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(wallet.publicKey);
      toast.success(t("DashboardCustody.policyAddressCopied"), { position: "bottom-right" });
    } catch {
      // Clipboard availability depends on browser permissions; the full address remains in the tooltip.
    }
  }

  return (
    <aside className="h-fit rounded-lg border border-border-default bg-white p-5 lg:sticky lg:top-0">
      <h2 className="text-base font-semibold text-primary">
        {t("DashboardCustody.policySummary")}
      </h2>
      <dl className="mt-4 divide-y divide-border-default">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted">{t("DashboardCustody.policySummaryWallet")}</dt>
          <dd className="max-w-48 truncate text-right text-sm font-medium text-primary">
            {wallet.label || wallet.walletId}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted">{t("DashboardCustody.policySummaryAddress")}</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={copyAddress}
                    className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-primary"
                    aria-label={t("DashboardCustody.policyCopyAddress")}
                  >
                    <span className="max-w-40 truncate">{wallet.publicKey}</span>
                    <Copy className="size-3.5 shrink-0 text-muted" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{wallet.publicKey}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </dd>
        </div>
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4 py-3">
            <dt className="text-sm text-muted">{row.label}</dt>
            <dd className="max-w-48 text-right text-sm font-medium text-primary">{row.value}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted">{t("DashboardCustody.policySummaryProvider")}</dt>
          <dd className="flex max-w-52 items-center gap-1.5 text-right text-sm font-medium text-primary">
            {warning ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <AlertTriangle className="size-4 text-warning" />
                  </TooltipTrigger>
                  <TooltipContent>{t("DashboardCustody.policyProviderWarning")}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <ShieldCheck className="size-4 text-muted" />
            )}
            <span>{providerMappingLabel}</span>
          </dd>
        </div>
      </dl>
    </aside>
  );
}

function formatProfileStatus(
  status: PolicyProfileStatus | null,
  t: ReturnType<typeof useTranslations>
): string {
  if (!status) return t("DashboardCustody.policyStatusDefaultAllow");
  const labels = {
    active: "DashboardCustody.policyStatusActive",
    draft: "DashboardCustody.policyStatusDraft",
    disabled: "DashboardCustody.policyStatusDisabled",
    archived: "DashboardCustody.policyStatusArchived",
  } as const;
  return t(labels[status]);
}

function formatSavedAt(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function DisableControlsDialog({
  open,
  walletName,
  submitting,
  onClose,
  onConfirm,
}: {
  open: boolean;
  walletName: string;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  return (
    <Modal
      isOpen={open}
      ariaLabel={t("DashboardCustody.policyDisableTitle")}
      onClose={onClose}
      closeDisabled={submitting}
      size="sm"
    >
      <div className="p-6">
        <h2 className="text-lg font-semibold text-primary">
          {t("DashboardCustody.policyDisableTitle")}
        </h2>
        <p className="mt-2 text-sm leading-6 text-secondary">
          {t("DashboardCustody.policyDisableConfirmation", { wallet: walletName })}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            {t("DashboardCustody.policyCancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={submitting}>
            {t("DashboardCustody.policyConfirmDisable")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
