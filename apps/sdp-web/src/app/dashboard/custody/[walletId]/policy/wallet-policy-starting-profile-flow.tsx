"use client";

import type { PaymentWalletPolicy } from "@sdp/types";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleDollarSign,
  LockKeyhole,
  MapPin,
  PauseCircle,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { updateWalletPolicy } from "@/app/dashboard/payments/payments-workspace.data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type FlowStep = "baseline" | "intent" | "details" | "review";
type ProfileState = "empty" | "draft" | "active" | "disabled";
type RestrictionCategoryId = "destinations" | "limits" | "operations" | "approvals";

interface WalletPolicyStartingProfileFlowProps {
  wallet: {
    walletId: string;
    publicKey: string;
    label: string | null;
    provider: string | null;
  };
  initialPolicy: PaymentWalletPolicy;
  policyError: string | null;
}

interface RestrictionCategory {
  id: RestrictionCategoryId;
  title: string;
  description: string;
  availability: "live" | "next";
  icon: LucideIcon;
}

interface StoredPolicyDraft {
  status: "draft" | "disabled";
  step: FlowStep;
  categories: RestrictionCategoryId[];
  destinationAllowlist: string[];
  maxTransferAmount: string;
  maxDailyAmount: string;
  updatedAt: string;
}

const FLOW_STEPS = [
  {
    id: "baseline",
    label: "Baseline",
    title: "Default allow",
    description: "Start open, then choose a few controls that match how this wallet is used.",
  },
  {
    id: "intent",
    label: "Intent",
    title: "Restriction intent",
    description: "Pick the policy areas that matter most. Two or three is usually enough.",
  },
  {
    id: "details",
    label: "Rules",
    title: "Starting rules",
    description: "Add the rules that can be activated from this flow.",
  },
  {
    id: "review",
    label: "Review",
    title: "Review before activation",
    description: "Confirm the profile before any wallet controls become active.",
  },
] as const satisfies readonly {
  id: FlowStep;
  label: string;
  title: string;
  description: string;
}[];

const RESTRICTION_CATEGORIES = [
  {
    id: "destinations",
    title: "Allowed destinations",
    description: "Use when this wallet should only pay known addresses.",
    availability: "live",
    icon: MapPin,
  },
  {
    id: "limits",
    title: "Transfer limits",
    description: "Use when this wallet needs spend caps or daily outflow limits.",
    availability: "live",
    icon: CircleDollarSign,
  },
  {
    id: "operations",
    title: "Operation types",
    description: "Use when this wallet should only perform certain actions.",
    availability: "next",
    icon: SlidersHorizontal,
  },
  {
    id: "approvals",
    title: "Approval review",
    description: "Use when sensitive actions should require human review.",
    availability: "next",
    icon: Users,
  },
] as const satisfies readonly RestrictionCategory[];

const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function draftStorageKey(walletId: string): string {
  return `sdp.wallet-policy-starting-profile.${walletId}`;
}

function policyHasRestrictions(policy: PaymentWalletPolicy): boolean {
  return (
    policy.destinationAllowlist.length > 0 ||
    Boolean(policy.maxTransferAmount) ||
    Boolean(policy.maxDailyAmount)
  );
}

function categoriesFromPolicy(policy: PaymentWalletPolicy): RestrictionCategoryId[] {
  const categories: RestrictionCategoryId[] = [];
  if (policy.destinationAllowlist.length > 0) categories.push("destinations");
  if (policy.maxTransferAmount || policy.maxDailyAmount) categories.push("limits");
  return categories;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseDestinationText(value: string): { addresses: string[]; invalid: string[] } {
  const parts = uniqueValues(value.split(/[\s,]+/));
  return {
    addresses: parts.filter((part) => SOLANA_ADDRESS_PATTERN.test(part)),
    invalid: parts.filter((part) => !SOLANA_ADDRESS_PATTERN.test(part)),
  };
}

function isPositiveAmount(value: string): boolean {
  return value.trim() === "" || /^\d+(\.\d+)?$/.test(value.trim());
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved draft";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function isStoredDraft(value: unknown): value is StoredPolicyDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<StoredPolicyDraft>;
  return (
    (draft.status === "draft" || draft.status === "disabled") &&
    typeof draft.step === "string" &&
    Array.isArray(draft.categories) &&
    Array.isArray(draft.destinationAllowlist) &&
    typeof draft.maxTransferAmount === "string" &&
    typeof draft.maxDailyAmount === "string" &&
    typeof draft.updatedAt === "string"
  );
}

export function WalletPolicyStartingProfileFlow({
  wallet,
  initialPolicy,
  policyError,
}: WalletPolicyStartingProfileFlowProps) {
  const router = useRouter();
  const [currentPolicy, setCurrentPolicy] = useState(initialPolicy);
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedCategories, setSelectedCategories] = useState<RestrictionCategoryId[]>(
    categoriesFromPolicy(initialPolicy)
  );
  const [destinationText, setDestinationText] = useState(
    initialPolicy.destinationAllowlist.join("\n")
  );
  const [maxTransferAmount, setMaxTransferAmount] = useState(initialPolicy.maxTransferAmount ?? "");
  const [maxDailyAmount, setMaxDailyAmount] = useState(initialPolicy.maxDailyAmount ?? "");
  const [savedDraft, setSavedDraft] = useState<StoredPolicyDraft | null>(null);
  const [localStatus, setLocalStatus] = useState<"draft" | "disabled" | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(draftStorageKey(wallet.walletId));
      if (!raw) {
        setIsLoaded(true);
        return;
      }

      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredDraft(parsed)) {
        setIsLoaded(true);
        return;
      }

      setSavedDraft(parsed);
      setLocalStatus(parsed.status);
      setSelectedCategories(parsed.categories);
      setDestinationText(parsed.destinationAllowlist.join("\n"));
      setMaxTransferAmount(parsed.maxTransferAmount);
      setMaxDailyAmount(parsed.maxDailyAmount);
      const draftStepIndex = FLOW_STEPS.findIndex((step) => step.id === parsed.step);
      setStepIndex(Math.max(0, draftStepIndex));
    } catch {
      // Ignore malformed local draft data.
    } finally {
      setIsLoaded(true);
    }
  }, [wallet.walletId]);

  const currentStep = FLOW_STEPS[stepIndex] ?? FLOW_STEPS[0];
  const selectedCategorySet = useMemo(() => new Set(selectedCategories), [selectedCategories]);
  const destinationParse = useMemo(() => parseDestinationText(destinationText), [destinationText]);
  const hasLivePolicy = policyHasRestrictions(currentPolicy);
  const hasDraft = Boolean(savedDraft && localStatus === "draft");
  const profileState: ProfileState = localStatus === "disabled"
    ? "disabled"
    : hasDraft
      ? "draft"
      : hasLivePolicy
        ? "active"
        : "empty";
  const selectedLiveCategories = selectedCategories.filter(
    (categoryId) =>
      RESTRICTION_CATEGORIES.find((category) => category.id === categoryId)?.availability === "live"
  );
  const selectedNextCategories = selectedCategories.filter(
    (categoryId) =>
      RESTRICTION_CATEGORIES.find((category) => category.id === categoryId)?.availability === "next"
  );
  const canActivateDestinations =
    !selectedCategorySet.has("destinations") ||
    (destinationParse.addresses.length > 0 && destinationParse.invalid.length === 0);
  const canActivateLimits =
    !selectedCategorySet.has("limits") ||
    (Boolean(maxTransferAmount.trim() || maxDailyAmount.trim()) &&
      isPositiveAmount(maxTransferAmount) &&
      isPositiveAmount(maxDailyAmount));
  const hasActivatableRestriction =
    (selectedCategorySet.has("destinations") && destinationParse.addresses.length > 0) ||
    (selectedCategorySet.has("limits") &&
      Boolean(maxTransferAmount.trim() || maxDailyAmount.trim()));
  const canActivate =
    selectedLiveCategories.length > 0 &&
    hasActivatableRestriction &&
    canActivateDestinations &&
    canActivateLimits &&
    !isSubmitting &&
    !policyError;

  function persistDraft(options: { notify: boolean } = { notify: false }) {
    if (typeof window === "undefined") return;

    const draft: StoredPolicyDraft = {
      status: "draft",
      step: currentStep.id,
      categories: selectedCategories,
      destinationAllowlist: destinationParse.addresses,
      maxTransferAmount: maxTransferAmount.trim(),
      maxDailyAmount: maxDailyAmount.trim(),
      updatedAt: new Date().toISOString(),
    };

    window.localStorage.setItem(draftStorageKey(wallet.walletId), JSON.stringify(draft));
    setSavedDraft(draft);
    setLocalStatus("draft");

    if (options.notify) {
      toast.success("Draft saved.", {
        description: "The profile is not active yet.",
        position: "bottom-right",
      });
    }
  }

  function clearDraft() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(draftStorageKey(wallet.walletId));
    }
    setSavedDraft(null);
    setLocalStatus(null);
  }

  function toggleCategory(categoryId: RestrictionCategoryId) {
    setSelectedCategories((current) =>
      current.includes(categoryId)
        ? current.filter((item) => item !== categoryId)
        : [...current, categoryId]
    );
    if (localStatus === "disabled") setLocalStatus(null);
  }

  function goNext() {
    if (currentStep.id === "intent" && selectedCategories.length === 0) {
      toast.error("Choose at least one restriction category.", {
        position: "bottom-right",
      });
      return;
    }

    if (currentStep.id === "details") {
      if (!canActivateDestinations) {
        toast.error("Check destination addresses.", {
          description: "Use valid Solana addresses before review.",
          position: "bottom-right",
        });
        return;
      }
      if (!canActivateLimits) {
        toast.error("Check transfer limits.", {
          description: "Enter a positive number for each configured limit.",
          position: "bottom-right",
        });
        return;
      }
    }

    if (currentStep.id !== "baseline") {
      persistDraft();
    }

    setStepIndex((current) => Math.min(current + 1, FLOW_STEPS.length - 1));
  }

  function goBack() {
    if (stepIndex === 0) {
      router.push(`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`);
      return;
    }
    setStepIndex((current) => Math.max(current - 1, 0));
  }

  function resetToLivePolicy() {
    setSelectedCategories(categoriesFromPolicy(currentPolicy));
    setDestinationText(currentPolicy.destinationAllowlist.join("\n"));
    setMaxTransferAmount(currentPolicy.maxTransferAmount ?? "");
    setMaxDailyAmount(currentPolicy.maxDailyAmount ?? "");
    clearDraft();
    toast.success("Draft cleared.", {
      description: "The flow now reflects the live wallet policy.",
      position: "bottom-right",
    });
  }

  async function activateProfile() {
    if (!canActivate) {
      persistDraft({ notify: true });
      return;
    }

    setIsSubmitting(true);
    const toastId = toast.loading("Activating wallet controls.", {
      position: "bottom-right",
    });
    try {
      const updated = await updateWalletPolicy(wallet.walletId, {
        walletId: wallet.walletId,
        destinationAllowlist: selectedCategorySet.has("destinations")
          ? destinationParse.addresses
          : [],
        ...(selectedCategorySet.has("limits") && maxTransferAmount.trim()
          ? { maxTransferAmount: maxTransferAmount.trim() }
          : {}),
        ...(selectedCategorySet.has("limits") && maxDailyAmount.trim()
          ? { maxDailyAmount: maxDailyAmount.trim() }
          : {}),
      });

      setCurrentPolicy(updated);
      if (selectedNextCategories.length > 0) {
        persistDraft();
      } else {
        clearDraft();
      }

      toast.success("Wallet controls active.", {
        id: toastId,
        description:
          selectedNextCategories.length > 0
            ? "Supported controls are active. Draft-only categories remain saved."
            : "Default allow now has the selected restrictions layered on top.",
        position: "bottom-right",
      });
    } catch (error) {
      toast.error("Activation failed.", {
        id: toastId,
        description: error instanceof Error ? error.message : "Wallet controls could not be saved.",
        position: "bottom-right",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function disableProfile() {
    setIsSubmitting(true);
    const toastId = toast.loading("Disabling wallet controls.", {
      position: "bottom-right",
    });
    try {
      const updated = await updateWalletPolicy(wallet.walletId, {
        walletId: wallet.walletId,
        destinationAllowlist: [],
      });

      const disabledDraft: StoredPolicyDraft = {
        status: "disabled",
        step: "baseline",
        categories: [],
        destinationAllowlist: [],
        maxTransferAmount: "",
        maxDailyAmount: "",
        updatedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(draftStorageKey(wallet.walletId), JSON.stringify(disabledDraft));

      setCurrentPolicy(updated);
      setSelectedCategories([]);
      setDestinationText("");
      setMaxTransferAmount("");
      setMaxDailyAmount("");
      setSavedDraft(disabledDraft);
      setLocalStatus("disabled");
      setStepIndex(0);

      toast.success("Wallet controls disabled.", {
        id: toastId,
        description: "The wallet is back to default allow.",
        position: "bottom-right",
      });
    } catch (error) {
      toast.error("Disable failed.", {
        id: toastId,
        description: error instanceof Error ? error.message : "Wallet controls could not be saved.",
        position: "bottom-right",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex h-[80vh] w-full max-w-xl flex-col px-4 py-4">
      <Link
        href={`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`}
        className="mb-5 inline-flex w-fit items-center gap-2 text-sm font-medium text-text-medium hover:text-text-extra-high"
      >
        <ArrowLeft className="size-4" />
        Wallet detail
      </Link>

      <StepIndicator stepIndex={stepIndex} />

      <div className="mt-6 space-y-1">
        <h1 className="text-2xl font-medium text-text-extra-high">{currentStep.title}</h1>
        <p className="text-sm text-text-medium">{currentStep.description}</p>
        {savedDraft?.updatedAt && localStatus === "draft" ? (
          <p className="pt-1 text-xs text-text-extra-low">
            Draft saved {formatDateTime(savedDraft.updatedAt)}
          </p>
        ) : null}
      </div>

      {policyError ? (
        <div className="mt-4 rounded-md border border-status-error-border bg-status-error-bg px-3 py-2 text-sm text-status-error-text">
          {policyError}
        </div>
      ) : null}

      <div className="mt-6 min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {!isLoaded ? <LoadingState /> : null}
        {isLoaded && currentStep.id === "baseline" ? (
          <BaselineStep
            state={profileState}
            policy={currentPolicy}
            onResumeDraft={() => {
              const draftStepIndex = savedDraft
                ? FLOW_STEPS.findIndex((step) => step.id === savedDraft.step)
                : 1;
              setStepIndex(Math.max(1, draftStepIndex));
            }}
          />
        ) : null}
        {isLoaded && currentStep.id === "intent" ? (
          <IntentStep selectedCategories={selectedCategories} onToggle={toggleCategory} />
        ) : null}
        {isLoaded && currentStep.id === "details" ? (
          <DetailsStep
            selectedCategorySet={selectedCategorySet}
            destinationText={destinationText}
            setDestinationText={setDestinationText}
            invalidDestinations={destinationParse.invalid}
            maxTransferAmount={maxTransferAmount}
            setMaxTransferAmount={setMaxTransferAmount}
            maxDailyAmount={maxDailyAmount}
            setMaxDailyAmount={setMaxDailyAmount}
          />
        ) : null}
        {isLoaded && currentStep.id === "review" ? (
          <ReviewStep
            selectedCategories={selectedCategories}
            destinationCount={destinationParse.addresses.length}
            invalidDestinationCount={destinationParse.invalid.length}
            maxTransferAmount={maxTransferAmount.trim()}
            maxDailyAmount={maxDailyAmount.trim()}
            selectedNextCategories={selectedNextCategories}
            canActivate={canActivate}
          />
        ) : null}
      </div>

      <footer className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="secondary"
            className="w-full sm:w-auto"
            onClick={goBack}
            iconLeft={<ArrowLeft className="size-4" />}
          >
            {stepIndex === 0 ? "Back" : "Previous"}
          </Button>
          {savedDraft ? (
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={resetToLivePolicy}
              iconLeft={<RotateCcw className="size-4" />}
              disabled={isSubmitting}
            >
              Clear draft
            </Button>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          {stepIndex > 0 ? (
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => persistDraft({ notify: true })}
              iconLeft={<Save className="size-4" />}
              disabled={isSubmitting}
            >
              Save draft
            </Button>
          ) : null}
          {hasLivePolicy && currentStep.id === "review" ? (
            <Button
              type="button"
              variant="destructive"
              className="w-full sm:w-auto"
              onClick={disableProfile}
              iconLeft={<PauseCircle className="size-4" />}
              disabled={isSubmitting}
            >
              Disable
            </Button>
          ) : null}
          <Button
            type="button"
            className="w-full sm:w-auto"
            onClick={currentStep.id === "review" ? activateProfile : goNext}
            iconRight={
              currentStep.id === "review" ? (
                <ShieldCheck className="size-4" />
              ) : (
                <ArrowRight className="size-4" />
              )
            }
            disabled={isSubmitting || Boolean(policyError && currentStep.id === "review")}
          >
            {currentStep.id === "review"
              ? canActivate
                ? "Activate controls"
                : "Save draft"
              : "Continue"}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function StepIndicator({ stepIndex }: { stepIndex: number }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        {FLOW_STEPS.map((step, index) => (
          <div
            key={step.id}
            className={cn(
              "h-1.5 rounded-full transition-all duration-200",
              index === stepIndex
                ? "w-4 bg-gray-1400"
                : index < stepIndex
                  ? "w-1.5 bg-gray-1400"
                  : "w-1.5 bg-border-light"
            )}
          />
        ))}
      </div>
      <span className="text-xs text-text-extra-low">
        Step {stepIndex + 1} of {FLOW_STEPS.length}
      </span>
    </div>
  );
}

function ProfileStateBadge({ state }: { state: ProfileState }) {
  if (state === "empty") return null;

  const meta: Record<
    Exclude<ProfileState, "empty">,
    { label: string; className: string; icon: LucideIcon }
  > = {
    draft: {
      label: "Draft",
      className: "bg-status-warning-bg text-status-warning-text",
      icon: Save,
    },
    active: {
      label: "Active",
      className: "bg-status-success-bg text-status-success-text",
      icon: ShieldCheck,
    },
    disabled: {
      label: "Disabled",
      className: "bg-[rgba(28,28,29,0.08)] text-text-medium",
      icon: PauseCircle,
    },
  };
  const Icon = meta[state].icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold",
        meta[state].className
      )}
    >
      <Icon className="size-3.5" />
      {meta[state].label}
    </span>
  );
}

function LoadingState() {
  return (
    <div className="grid gap-3">
      <div className="h-20 animate-pulse rounded-lg bg-gray-100" />
      <div className="h-20 animate-pulse rounded-lg bg-gray-100" />
      <div className="h-20 animate-pulse rounded-lg bg-gray-100" />
    </div>
  );
}

function BaselineStep({
  state,
  policy,
  onResumeDraft,
}: {
  state: ProfileState;
  policy: PaymentWalletPolicy;
  onResumeDraft: () => void;
}) {
  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <div className="space-y-2">
          <ProfileStateBadge state={state} />
          <h2 className="text-lg font-medium text-text-extra-high">
            Default allow stays the baseline.
          </h2>
          <p className="text-sm leading-6 text-text-medium">
            A wallet can move funds unless a restriction is activated. Start with the open baseline,
            then choose the few controls that reduce real risk for this wallet.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium tracking-[0.14em] text-text-extra-low uppercase">
            Current controls
          </p>
          <div className="divide-y divide-border-light">
            <PolicySummaryRow
              label="Destinations"
              value={
                policy.destinationAllowlist.length
                  ? `${policy.destinationAllowlist.length} allowed`
                  : "Open"
              }
            />
            <PolicySummaryRow label="Per transfer" value={policy.maxTransferAmount ?? "No cap"} />
            <PolicySummaryRow label="Daily" value={policy.maxDailyAmount ?? "No cap"} />
          </div>
        </div>
      </div>

      {state === "draft" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <button
            type="button"
            onClick={onResumeDraft}
            className="rounded-lg border border-status-warning-border bg-status-warning-bg p-4 text-left transition-colors hover:bg-status-warning-bg/80"
          >
            <Save className="size-5 text-status-warning-text" />
            <p className="mt-3 text-sm font-semibold text-text-extra-high">Resume draft</p>
            <p className="mt-1 text-sm leading-6 text-text-medium">
              Continue the saved profile before anything is activated.
            </p>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function IntentStep({
  selectedCategories,
  onToggle,
}: {
  selectedCategories: RestrictionCategoryId[];
  onToggle: (category: RestrictionCategoryId) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {RESTRICTION_CATEGORIES.map((category) => {
        const selected = selectedCategories.includes(category.id);

        return (
          <button
            key={category.id}
            type="button"
            onClick={() => onToggle(category.id)}
            aria-pressed={selected}
            className={cn(
              "relative min-h-[150px] rounded-lg border p-4 pr-14 text-left transition-colors",
              selected
                ? "border-[rgba(28,28,29,0.72)] bg-[rgba(28,28,29,0.04)] shadow-[inset_0_0_0_1px_rgba(28,28,29,0.72)]"
                : "border-border-light bg-white hover:bg-gray-100"
            )}
          >
            <p className="text-base font-semibold text-text-extra-high">{category.title}</p>
            <p className="mt-2 text-sm leading-6 text-text-medium">{category.description}</p>
            {selected ? (
              <span className="absolute right-4 bottom-4 flex size-6 items-center justify-center rounded-full bg-gray-1400 text-white">
                <Check className="size-4" />
                <span className="sr-only">Selected</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function DetailsStep({
  selectedCategorySet,
  destinationText,
  setDestinationText,
  invalidDestinations,
  maxTransferAmount,
  setMaxTransferAmount,
  maxDailyAmount,
  setMaxDailyAmount,
}: {
  selectedCategorySet: Set<RestrictionCategoryId>;
  destinationText: string;
  setDestinationText: (value: string) => void;
  invalidDestinations: string[];
  maxTransferAmount: string;
  setMaxTransferAmount: (value: string) => void;
  maxDailyAmount: string;
  setMaxDailyAmount: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      {selectedCategorySet.has("destinations") ? (
        <section className="rounded-lg border border-border-light bg-white p-4">
          <div className="flex items-start gap-3">
            <MapPin className="mt-0.5 size-5 text-[color:var(--sdp-color-info-text)]" />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-text-extra-high">Allowed destinations</h2>
              <p className="mt-1 text-sm leading-6 text-text-medium">
                Add one Solana address per line. Only these destinations will be allowed for
                outbound payment transfers.
              </p>
              <textarea
                value={destinationText}
                onChange={(event) => setDestinationText(event.target.value)}
                rows={6}
                className="mt-4 min-h-[150px] w-full resize-y rounded-lg border border-border-light bg-white px-3 py-3 font-mono text-sm text-text-extra-high outline-none transition-colors placeholder:text-text-extra-low focus:border-gray-1400"
                placeholder="9xQeWvG816bUx9EPfuxEzHh9VY5k..."
              />
              {invalidDestinations.length > 0 ? (
                <p className="mt-2 text-sm text-status-error-text">
                  Invalid address{invalidDestinations.length === 1 ? "" : "es"}:{" "}
                  {invalidDestinations.join(", ")}
                </p>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {selectedCategorySet.has("limits") ? (
        <section className="rounded-lg border border-border-light bg-white p-4">
          <div className="flex items-start gap-3">
            <CircleDollarSign className="mt-0.5 size-5 text-[color:var(--sdp-color-info-text)]" />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-text-extra-high">Transfer limits</h2>
              <p className="mt-1 text-sm leading-6 text-text-medium">
                Configure one or both caps. Amounts are interpreted by the payment policy endpoint.
              </p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-sm font-medium text-text-extra-high">Per transfer cap</span>
                  <Input
                    value={maxTransferAmount}
                    onChange={(event) => setMaxTransferAmount(event.target.value)}
                    placeholder="1000"
                    inputMode="decimal"
                  />
                  {!isPositiveAmount(maxTransferAmount) ? (
                    <span className="block text-sm text-status-error-text">
                      Enter a positive number.
                    </span>
                  ) : null}
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-text-extra-high">Daily cap</span>
                  <Input
                    value={maxDailyAmount}
                    onChange={(event) => setMaxDailyAmount(event.target.value)}
                    placeholder="5000"
                    inputMode="decimal"
                  />
                  {!isPositiveAmount(maxDailyAmount) ? (
                    <span className="block text-sm text-status-error-text">
                      Enter a positive number.
                    </span>
                  ) : null}
                </label>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {selectedCategorySet.has("operations") || selectedCategorySet.has("approvals") ? (
        <section className="rounded-lg border border-status-warning-border bg-status-warning-bg p-4">
          <div className="flex items-start gap-3">
            <LockKeyhole className="mt-0.5 size-5 text-status-warning-text" />
            <div>
              <h2 className="text-base font-semibold text-text-extra-high">
                Detailed rule setup follows this starting profile.
              </h2>
              <p className="mt-1 text-sm leading-6 text-text-medium">
                Operation-type and approval-review intent is saved in the draft, then configured in
                the detailed rule setup flow.
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ReviewStep({
  selectedCategories,
  destinationCount,
  invalidDestinationCount,
  maxTransferAmount,
  maxDailyAmount,
  selectedNextCategories,
  canActivate,
}: {
  selectedCategories: RestrictionCategoryId[];
  destinationCount: number;
  invalidDestinationCount: number;
  maxTransferAmount: string;
  maxDailyAmount: string;
  selectedNextCategories: RestrictionCategoryId[];
  canActivate: boolean;
}) {
  const selected = RESTRICTION_CATEGORIES.filter((category) =>
    selectedCategories.includes(category.id)
  );

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border-light bg-[rgba(28,28,29,0.03)] p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 text-[color:var(--sdp-color-info-text)]" />
          <div>
            <h2 className="text-base font-semibold text-text-extra-high">
              Default allow plus selected restrictions
            </h2>
            <p className="mt-1 text-sm leading-6 text-text-medium">
              Activation writes the controls supported by the current wallet policy API. Draft-only
              categories remain recoverable for detailed rule setup.
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-3">
        {selected.length > 0 ? (
          selected.map((category) => (
            <ReviewCategory
              key={category.id}
              category={category}
              destinationCount={destinationCount}
              invalidDestinationCount={invalidDestinationCount}
              maxTransferAmount={maxTransferAmount}
              maxDailyAmount={maxDailyAmount}
            />
          ))
        ) : (
          <div className="rounded-lg border border-border-light bg-white p-4 text-sm text-text-medium">
            No restriction category selected.
          </div>
        )}
      </div>

      {!canActivate ? (
        <div className="rounded-lg border border-status-warning-border bg-status-warning-bg p-4 text-sm leading-6 text-text-medium">
          Add at least one activatable destination or transfer limit before activation. Saving a
          draft keeps this profile inactive.
        </div>
      ) : null}

      {selectedNextCategories.length > 0 ? (
        <div className="rounded-lg border border-border-light bg-white p-4 text-sm leading-6 text-text-medium">
          {selectedNextCategories.length} draft-only category
          {selectedNextCategories.length === 1 ? "" : "ies"} will remain saved after activation.
        </div>
      ) : null}
    </div>
  );
}

function ReviewCategory({
  category,
  destinationCount,
  invalidDestinationCount,
  maxTransferAmount,
  maxDailyAmount,
}: {
  category: RestrictionCategory;
  destinationCount: number;
  invalidDestinationCount: number;
  maxTransferAmount: string;
  maxDailyAmount: string;
}) {
  const Icon = category.icon;
  let value = "Saved for rule setup";
  if (category.id === "destinations") {
    value =
      invalidDestinationCount > 0
        ? `${invalidDestinationCount} invalid`
        : destinationCount > 0
          ? `${destinationCount} allowed`
          : "No addresses";
  }
  if (category.id === "limits") {
    const parts = [
      maxTransferAmount ? `Per transfer ${maxTransferAmount}` : null,
      maxDailyAmount ? `Daily ${maxDailyAmount}` : null,
    ].filter(Boolean);
    value = parts.length > 0 ? parts.join(" / ") : "No cap";
  }

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border-light bg-white p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[rgba(33,99,182,0.12)] text-[color:var(--sdp-color-info-text)]">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-extra-high">{category.title}</p>
          <p className="mt-1 text-sm leading-6 text-text-medium">{value}</p>
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-md px-2 py-1 text-xs font-semibold",
          category.availability === "live"
            ? "bg-status-success-bg text-status-success-text"
            : "bg-status-warning-bg text-status-warning-text"
        )}
      >
        {category.availability === "live" ? "Activation" : "Draft"}
      </span>
    </div>
  );
}

function PolicySummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 text-sm">
      <span className="text-text-low">{label}</span>
      <span className="truncate font-medium text-text-extra-high" title={value}>
        {value}
      </span>
    </div>
  );
}
