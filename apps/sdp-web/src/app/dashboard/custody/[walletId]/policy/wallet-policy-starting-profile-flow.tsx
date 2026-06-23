"use client";

import type { PaymentWalletPolicy } from "@sdp/types";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Check,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { updateWalletPolicy } from "@/app/dashboard/payments/payments-workspace.data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type FlowStep = "intent" | "details" | "review";
type RestrictionCategoryId = "destinations" | "limits" | "operations" | "approvals";
type OperationRuleId =
  | "payment_transfers"
  | "ramp_transactions"
  | "token_issuance";
type ApprovalRuleId = "large_transfers" | "new_destinations" | "admin_actions";

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
}

interface ToggleOption<TValue extends string> {
  id: TValue;
  title: string;
  description: string;
}

interface StoredPolicyDraft {
  status: "draft" | "disabled";
  step: FlowStep;
  categories: RestrictionCategoryId[];
  destinationAllowlist: string[];
  maxTransferAmount: string;
  maxDailyAmount: string;
  operationRules: OperationRuleId[];
  approvalRules: ApprovalRuleId[];
  approvalTransferAmount: string;
  updatedAt: string;
}

const FLOW_STEPS = [
  {
    id: "intent",
    label: "Intent",
    title: "Set wallet policies",
    description:
      "Choose a few guardrails for this wallet. Policies can limit where funds go, cap transfer amounts, narrow allowed operations, or require review before sensitive actions.",
  },
  {
    id: "details",
    label: "Rules",
    title: "Starting rules",
    description: "Configure the selected rule areas before review.",
  },
  {
    id: "review",
    label: "Review",
    title: "Final review",
    description: "Review the changes before applying supported controls.",
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
  },
  {
    id: "limits",
    title: "Transfer limits",
    description: "Use when this wallet needs spend caps or daily outflow limits.",
    availability: "live",
  },
  {
    id: "operations",
    title: "Operation types",
    description: "Use when this wallet should only perform certain actions.",
    availability: "next",
  },
  {
    id: "approvals",
    title: "Approval review",
    description: "Use when sensitive actions should require human review.",
    availability: "next",
  },
] as const satisfies readonly RestrictionCategory[];

const RESTRICTION_CATEGORY_IDS = RESTRICTION_CATEGORIES.map((category) => category.id);

const OPERATION_RULE_OPTIONS = [
  {
    id: "payment_transfers",
    title: "Payment transfers",
    description: "Allow standard outbound payment transfers from this wallet.",
  },
  {
    id: "ramp_transactions",
    title: "Ramp transactions",
    description: "Allow on-ramp and off-ramp execution tied to this wallet.",
  },
  {
    id: "token_issuance",
    title: "Token issuance",
    description: "Allow minting, burning, freezing, and token administration actions.",
  },
] as const satisfies readonly ToggleOption<OperationRuleId>[];

const OPERATION_RULE_IDS = OPERATION_RULE_OPTIONS.map((option) => option.id);

const APPROVAL_RULE_OPTIONS = [
  {
    id: "large_transfers",
    title: "Transfers above an amount",
    description: "Require review before high-value transfers are signed.",
  },
  {
    id: "new_destinations",
    title: "New destinations",
    description: "Require review before sending funds to a destination not seen before.",
  },
  {
    id: "admin_actions",
    title: "Administrative actions",
    description: "Require review for provider, wallet, or policy administration.",
  },
] as const satisfies readonly ToggleOption<ApprovalRuleId>[];

const APPROVAL_RULE_IDS = APPROVAL_RULE_OPTIONS.map((option) => option.id);

const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CSV_HEADER_VALUES = new Set([
  "address",
  "addresses",
  "destination",
  "destinations",
  "pubkey",
  "public_key",
]);

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

function filterKnownValues<TValue extends string>(
  values: unknown,
  allowedValues: readonly TValue[]
): TValue[] {
  if (!Array.isArray(values)) return [];
  const allowed = new Set<string>(allowedValues);
  return values.filter((value): value is TValue => typeof value === "string" && allowed.has(value));
}

function parseCsvCells(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let isQuoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && nextCharacter === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      isQuoted = !isQuoted;
      continue;
    }

    if (!isQuoted && (character === "," || character === "\t" || character === ";")) {
      cells.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  cells.push(current);
  return cells;
}

function normalizeCsvCell(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").trim();
}

function looksLikeAddressInput(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{16,64}$/.test(value);
}

function parseDestinationText(value: string): { addresses: string[]; invalid: string[] } {
  const parts = uniqueValues(
    value
      .split(/\r?\n/)
      .flatMap((line) => parseCsvCells(line))
      .flatMap((cell) => normalizeCsvCell(cell).split(/\s+/))
      .map(normalizeCsvCell)
      .filter((part) => !CSV_HEADER_VALUES.has(part.toLowerCase()))
  );
  return {
    addresses: parts.filter((part) => SOLANA_ADDRESS_PATTERN.test(part)),
    invalid: parts.filter(
      (part) => !SOLANA_ADDRESS_PATTERN.test(part) && looksLikeAddressInput(part)
    ),
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
    (draft.operationRules === undefined || Array.isArray(draft.operationRules)) &&
    (draft.approvalRules === undefined || Array.isArray(draft.approvalRules)) &&
    (draft.approvalTransferAmount === undefined ||
      typeof draft.approvalTransferAmount === "string") &&
    typeof draft.updatedAt === "string"
  );
}

function toggleValue<TValue extends string>(values: TValue[], value: TValue): TValue[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatOptionTitles<TValue extends string>(
  selectedIds: TValue[],
  options: readonly ToggleOption<TValue>[]
): string {
  const selectedTitles = options
    .filter((option) => selectedIds.includes(option.id))
    .map((option) => option.title);
  return selectedTitles.length > 0 ? selectedTitles.join(", ") : "None selected";
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
  const [expandedRuleIds, setExpandedRuleIds] = useState<RestrictionCategoryId[]>(
    categoriesFromPolicy(initialPolicy)
  );
  const [destinationText, setDestinationText] = useState(
    initialPolicy.destinationAllowlist.join("\n")
  );
  const [maxTransferAmount, setMaxTransferAmount] = useState(initialPolicy.maxTransferAmount ?? "");
  const [maxDailyAmount, setMaxDailyAmount] = useState(initialPolicy.maxDailyAmount ?? "");
  const [selectedOperationRules, setSelectedOperationRules] = useState<OperationRuleId[]>([]);
  const [selectedApprovalRules, setSelectedApprovalRules] = useState<ApprovalRuleId[]>([]);
  const [approvalTransferAmount, setApprovalTransferAmount] = useState("");
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

      const draftCategories = filterKnownValues(parsed.categories, RESTRICTION_CATEGORY_IDS);
      setSavedDraft(parsed);
      setLocalStatus(parsed.status);
      setSelectedCategories(draftCategories);
      setExpandedRuleIds(draftCategories);
      setDestinationText(parsed.destinationAllowlist.join("\n"));
      setMaxTransferAmount(parsed.maxTransferAmount);
      setMaxDailyAmount(parsed.maxDailyAmount);
      setSelectedOperationRules(filterKnownValues(parsed.operationRules, OPERATION_RULE_IDS));
      setSelectedApprovalRules(filterKnownValues(parsed.approvalRules, APPROVAL_RULE_IDS));
      setApprovalTransferAmount(parsed.approvalTransferAmount ?? "");
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
  const expandedRuleSet = useMemo(() => new Set(expandedRuleIds), [expandedRuleIds]);
  const destinationParse = useMemo(() => parseDestinationText(destinationText), [destinationText]);
  const hasLivePolicy = policyHasRestrictions(currentPolicy);
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
  const canConfigureOperations =
    !selectedCategorySet.has("operations") || selectedOperationRules.length > 0;
  const canConfigureApprovals =
    !selectedCategorySet.has("approvals") ||
    (selectedApprovalRules.length > 0 &&
      (!selectedApprovalRules.includes("large_transfers") ||
        (Boolean(approvalTransferAmount.trim()) && isPositiveAmount(approvalTransferAmount))));
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
  const canSubmitReview =
    selectedCategories.length > 0 &&
    canActivateDestinations &&
    canActivateLimits &&
    canConfigureOperations &&
    canConfigureApprovals &&
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
      operationRules: selectedOperationRules,
      approvalRules: selectedApprovalRules,
      approvalTransferAmount: approvalTransferAmount.trim(),
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
    setSelectedCategories((current) => toggleValue(current, categoryId));
    setExpandedRuleIds((current) =>
      selectedCategorySet.has(categoryId)
        ? current.filter((item) => item !== categoryId)
        : current.includes(categoryId)
          ? current
          : [...current, categoryId]
    );
    if (localStatus === "disabled") setLocalStatus(null);
  }

  function toggleExpandedRule(categoryId: RestrictionCategoryId) {
    setExpandedRuleIds((current) => toggleValue(current, categoryId));
  }

  function toggleOperationRule(ruleId: OperationRuleId) {
    setSelectedOperationRules((current) => toggleValue(current, ruleId));
    if (localStatus === "disabled") setLocalStatus(null);
  }

  function toggleApprovalRule(ruleId: ApprovalRuleId) {
    setSelectedApprovalRules((current) => toggleValue(current, ruleId));
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
      if (!canConfigureOperations) {
        toast.error("Choose allowed operation types.", {
          description: "Select at least one operation type before review.",
          position: "bottom-right",
        });
        return;
      }
      if (!canConfigureApprovals) {
        toast.error("Check approval rules.", {
          description: "Choose at least one review trigger and complete any amount fields.",
          position: "bottom-right",
        });
        return;
      }
    }

    persistDraft();

    setStepIndex((current) => Math.min(current + 1, FLOW_STEPS.length - 1));
  }

  function goBack() {
    if (stepIndex === 0) {
      router.push(`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`);
      return;
    }
    setStepIndex((current) => Math.max(current - 1, 0));
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
        step: "intent",
        categories: [],
        destinationAllowlist: [],
        maxTransferAmount: "",
        maxDailyAmount: "",
        operationRules: [],
        approvalRules: [],
        approvalTransferAmount: "",
        updatedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(draftStorageKey(wallet.walletId), JSON.stringify(disabledDraft));

      setCurrentPolicy(updated);
      setSelectedCategories([]);
      setDestinationText("");
      setMaxTransferAmount("");
      setMaxDailyAmount("");
      setSelectedOperationRules([]);
      setSelectedApprovalRules([]);
      setApprovalTransferAmount("");
      setExpandedRuleIds([]);
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
        {isLoaded && currentStep.id === "intent" ? (
          <IntentStep selectedCategories={selectedCategories} onToggle={toggleCategory} />
        ) : null}
        {isLoaded && currentStep.id === "details" ? (
          <DetailsStep
            selectedCategories={selectedCategories}
            expandedRuleSet={expandedRuleSet}
            onToggleExpandedRule={toggleExpandedRule}
            destinationText={destinationText}
            setDestinationText={setDestinationText}
            destinationCount={destinationParse.addresses.length}
            invalidDestinations={destinationParse.invalid}
            maxTransferAmount={maxTransferAmount}
            setMaxTransferAmount={setMaxTransferAmount}
            maxDailyAmount={maxDailyAmount}
            setMaxDailyAmount={setMaxDailyAmount}
            selectedOperationRules={selectedOperationRules}
            onToggleOperationRule={toggleOperationRule}
            selectedApprovalRules={selectedApprovalRules}
            onToggleApprovalRule={toggleApprovalRule}
            approvalTransferAmount={approvalTransferAmount}
            setApprovalTransferAmount={setApprovalTransferAmount}
          />
        ) : null}
        {isLoaded && currentStep.id === "review" ? (
          <ReviewStep
            selectedCategories={selectedCategories}
            destinationCount={destinationParse.addresses.length}
            invalidDestinationCount={destinationParse.invalid.length}
            maxTransferAmount={maxTransferAmount.trim()}
            maxDailyAmount={maxDailyAmount.trim()}
            selectedOperationRules={selectedOperationRules}
            selectedApprovalRules={selectedApprovalRules}
            approvalTransferAmount={approvalTransferAmount.trim()}
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
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          {hasLivePolicy && currentStep.id === "review" ? (
            <Button
              type="button"
              variant="destructive"
              className="w-full sm:w-auto"
              onClick={disableProfile}
              disabled={isSubmitting}
            >
              Disable
            </Button>
          ) : null}
          <Button
            type="button"
            className="w-full sm:w-auto"
            onClick={currentStep.id === "review" ? activateProfile : goNext}
            iconRight={currentStep.id === "review" ? undefined : <ArrowRight className="size-4" />}
            disabled={
              isSubmitting ||
              Boolean(policyError && currentStep.id === "review") ||
              (currentStep.id === "review" && !canSubmitReview)
            }
          >
            {currentStep.id === "review"
              ? canActivate
                ? "Apply controls"
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

function LoadingState() {
  return (
    <div className="grid gap-3">
      <div className="h-20 animate-pulse rounded-lg bg-gray-100" />
      <div className="h-20 animate-pulse rounded-lg bg-gray-100" />
      <div className="h-20 animate-pulse rounded-lg bg-gray-100" />
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
  selectedCategories,
  expandedRuleSet,
  onToggleExpandedRule,
  destinationText,
  setDestinationText,
  destinationCount,
  invalidDestinations,
  maxTransferAmount,
  setMaxTransferAmount,
  maxDailyAmount,
  setMaxDailyAmount,
  selectedOperationRules,
  onToggleOperationRule,
  selectedApprovalRules,
  onToggleApprovalRule,
  approvalTransferAmount,
  setApprovalTransferAmount,
}: {
  selectedCategories: RestrictionCategoryId[];
  expandedRuleSet: Set<RestrictionCategoryId>;
  onToggleExpandedRule: (category: RestrictionCategoryId) => void;
  destinationText: string;
  setDestinationText: (value: string) => void;
  destinationCount: number;
  invalidDestinations: string[];
  maxTransferAmount: string;
  setMaxTransferAmount: (value: string) => void;
  maxDailyAmount: string;
  setMaxDailyAmount: (value: string) => void;
  selectedOperationRules: OperationRuleId[];
  onToggleOperationRule: (rule: OperationRuleId) => void;
  selectedApprovalRules: ApprovalRuleId[];
  onToggleApprovalRule: (rule: ApprovalRuleId) => void;
  approvalTransferAmount: string;
  setApprovalTransferAmount: (value: string) => void;
}) {
  const selected = RESTRICTION_CATEGORIES.filter((category) =>
    selectedCategories.includes(category.id)
  );

  return (
    <div className="overflow-hidden rounded-lg">
      {selected.map((category) => {
        const expanded = expandedRuleSet.has(category.id);

        return (
          <RuleSection
            key={category.id}
            category={category}
            expanded={expanded}
            summary={getRuleSummary({
              categoryId: category.id,
              destinationCount,
              maxTransferAmount,
              maxDailyAmount,
              selectedOperationRules,
              selectedApprovalRules,
            })}
            onToggle={() => onToggleExpandedRule(category.id)}
          >
            {category.id === "destinations" ? (
              <DestinationRuleEditor
                destinationText={destinationText}
                setDestinationText={setDestinationText}
                invalidDestinations={invalidDestinations}
              />
            ) : null}
            {category.id === "limits" ? (
              <LimitRuleEditor
                maxTransferAmount={maxTransferAmount}
                setMaxTransferAmount={setMaxTransferAmount}
                maxDailyAmount={maxDailyAmount}
                setMaxDailyAmount={setMaxDailyAmount}
              />
            ) : null}
            {category.id === "operations" ? (
              <ToggleOptionList
                options={OPERATION_RULE_OPTIONS}
                selectedValues={selectedOperationRules}
                onToggle={onToggleOperationRule}
              />
            ) : null}
            {category.id === "approvals" ? (
              <ApprovalRuleEditor
                selectedApprovalRules={selectedApprovalRules}
                onToggleApprovalRule={onToggleApprovalRule}
                approvalTransferAmount={approvalTransferAmount}
                setApprovalTransferAmount={setApprovalTransferAmount}
              />
            ) : null}
          </RuleSection>
        );
      })}
    </div>
  );
}

function RuleSection({
  category,
  expanded,
  summary,
  onToggle,
  children,
}: {
  category: RestrictionCategory;
  expanded: boolean;
  summary: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border-light first:border-t-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-gray-100"
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold text-text-extra-high">
            {category.title}
          </span>
          <span className="mt-1 block text-sm leading-5 text-text-medium">{summary}</span>
        </span>
        <span className="flex size-6 shrink-0 items-center justify-center text-text-low">
          <ChevronDown
            aria-hidden="true"
            className={cn("size-4 transition-transform duration-200", expanded && "rotate-180")}
          />
          <span className="sr-only">{expanded ? "Collapse" : "Expand"}</span>
        </span>
      </button>
      {expanded ? <div className="px-4 pb-5">{children}</div> : null}
    </section>
  );
}

function DestinationRuleEditor({
  destinationText,
  setDestinationText,
  invalidDestinations,
}: {
  destinationText: string;
  setDestinationText: (value: string) => void;
  invalidDestinations: string[];
}) {
  return (
    <div>
      <p className="text-sm leading-6 text-text-medium">
        Paste Solana addresses separated by line breaks, commas, semicolons, tabs, or a CSV column.
      </p>
      <textarea
        value={destinationText}
        onChange={(event) => setDestinationText(event.target.value)}
        rows={6}
        className="mt-3 min-h-[140px] w-full resize-y rounded-lg border border-border-light bg-white px-3 py-3 font-mono text-sm text-text-extra-high outline-none transition-colors placeholder:text-text-extra-low focus:border-gray-1400"
        placeholder="address&#10;9xQeWvG816bUx9EPfuxEzHh9VY5k..."
      />
      {invalidDestinations.length > 0 ? (
        <p className="mt-2 text-sm text-status-error-text">
          Invalid address{invalidDestinations.length === 1 ? "" : "es"}:{" "}
          {invalidDestinations.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function LimitRuleEditor({
  maxTransferAmount,
  setMaxTransferAmount,
  maxDailyAmount,
  setMaxDailyAmount,
}: {
  maxTransferAmount: string;
  setMaxTransferAmount: (value: string) => void;
  maxDailyAmount: string;
  setMaxDailyAmount: (value: string) => void;
}) {
  return (
    <div>
      <p className="text-sm leading-6 text-text-medium">
        Configure one or both caps. Amounts are interpreted by the payment policy endpoint.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="space-y-2">
          <span className="text-sm font-medium text-text-extra-high">Per transfer cap</span>
          <Input
            value={maxTransferAmount}
            onChange={(event) => setMaxTransferAmount(event.target.value)}
            placeholder="1000"
            inputMode="decimal"
          />
          {!isPositiveAmount(maxTransferAmount) ? (
            <span className="block text-sm text-status-error-text">Enter a positive number.</span>
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
            <span className="block text-sm text-status-error-text">Enter a positive number.</span>
          ) : null}
        </label>
      </div>
    </div>
  );
}

function ToggleOptionList<TValue extends string>({
  options,
  selectedValues,
  onToggle,
}: {
  options: readonly ToggleOption<TValue>[];
  selectedValues: TValue[];
  onToggle: (value: TValue) => void;
}) {
  return (
    <div className="space-y-3">
      {options.map((option) => (
        <label key={option.id} className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={selectedValues.includes(option.id)}
            onChange={() => onToggle(option.id)}
            className="mt-1 size-4 rounded border-border-light accent-gray-1400"
          />
          <span>
            <span className="block font-medium text-text-extra-high">{option.title}</span>
            <span className="mt-1 block leading-5 text-text-medium">{option.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function ApprovalRuleEditor({
  selectedApprovalRules,
  onToggleApprovalRule,
  approvalTransferAmount,
  setApprovalTransferAmount,
}: {
  selectedApprovalRules: ApprovalRuleId[];
  onToggleApprovalRule: (rule: ApprovalRuleId) => void;
  approvalTransferAmount: string;
  setApprovalTransferAmount: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      <ToggleOptionList
        options={APPROVAL_RULE_OPTIONS}
        selectedValues={selectedApprovalRules}
        onToggle={onToggleApprovalRule}
      />
      {selectedApprovalRules.includes("large_transfers") ? (
        <label className="block max-w-xs space-y-2">
          <span className="text-sm font-medium text-text-extra-high">Review transfer amount</span>
          <Input
            value={approvalTransferAmount}
            onChange={(event) => setApprovalTransferAmount(event.target.value)}
            placeholder="1000"
            inputMode="decimal"
          />
          {!isPositiveAmount(approvalTransferAmount) ? (
            <span className="block text-sm text-status-error-text">Enter a positive number.</span>
          ) : null}
        </label>
      ) : null}
    </div>
  );
}

function getRuleSummary({
  categoryId,
  destinationCount,
  maxTransferAmount,
  maxDailyAmount,
  selectedOperationRules,
  selectedApprovalRules,
}: {
  categoryId: RestrictionCategoryId;
  destinationCount: number;
  maxTransferAmount: string;
  maxDailyAmount: string;
  selectedOperationRules: OperationRuleId[];
  selectedApprovalRules: ApprovalRuleId[];
}) {
  if (categoryId === "destinations") {
    return destinationCount > 0
      ? formatCount(destinationCount, "address", "addresses")
      : "Paste approved Solana addresses or a CSV address column.";
  }

  if (categoryId === "limits") {
    const parts = [
      maxTransferAmount.trim() ? `Per transfer ${maxTransferAmount.trim()}` : null,
      maxDailyAmount.trim() ? `Daily ${maxDailyAmount.trim()}` : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" / ") : "Set a per-transfer cap, daily cap, or both.";
  }

  if (categoryId === "operations") {
    return selectedOperationRules.length > 0
      ? formatOptionTitles(selectedOperationRules, OPERATION_RULE_OPTIONS)
      : "Choose the operations this wallet should be allowed to perform.";
  }

  return selectedApprovalRules.length > 0
    ? formatOptionTitles(selectedApprovalRules, APPROVAL_RULE_OPTIONS)
    : "Choose which sensitive actions should require review.";
}

function ReviewStep({
  selectedCategories,
  destinationCount,
  invalidDestinationCount,
  maxTransferAmount,
  maxDailyAmount,
  selectedOperationRules,
  selectedApprovalRules,
  approvalTransferAmount,
  selectedNextCategories,
  canActivate,
}: {
  selectedCategories: RestrictionCategoryId[];
  destinationCount: number;
  invalidDestinationCount: number;
  maxTransferAmount: string;
  maxDailyAmount: string;
  selectedOperationRules: OperationRuleId[];
  selectedApprovalRules: ApprovalRuleId[];
  approvalTransferAmount: string;
  selectedNextCategories: RestrictionCategoryId[];
  canActivate: boolean;
}) {
  const selected = RESTRICTION_CATEGORIES.filter((category) =>
    selectedCategories.includes(category.id)
  );

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-border-light bg-white">
        {selected.length > 0 ? (
          selected.map((category) => (
            <ReviewCategory
              key={category.id}
              category={category}
              destinationCount={destinationCount}
              invalidDestinationCount={invalidDestinationCount}
              maxTransferAmount={maxTransferAmount}
              maxDailyAmount={maxDailyAmount}
              selectedOperationRules={selectedOperationRules}
              selectedApprovalRules={selectedApprovalRules}
              approvalTransferAmount={approvalTransferAmount}
            />
          ))
        ) : (
          <div className="p-4 text-sm text-text-medium">
            No restriction category selected.
          </div>
        )}
      </div>

      {!canActivate ? (
        <div className="rounded-lg border border-status-warning-border bg-status-warning-bg p-4 text-sm leading-6 text-text-medium">
          No destination or transfer limit is ready to apply yet. Continuing saves the configured
          profile as a draft.
        </div>
      ) : null}

      {selectedNextCategories.length > 0 ? (
        <div className="rounded-lg border border-border-light bg-white p-4 text-sm leading-6 text-text-medium">
          {canActivate
            ? "Destination and transfer limits can be applied now. Operation and approval settings are reviewed here and saved for detailed policy support."
            : "Operation and approval settings are reviewed here and saved for detailed policy support."}
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
  selectedOperationRules,
  selectedApprovalRules,
  approvalTransferAmount,
}: {
  category: RestrictionCategory;
  destinationCount: number;
  invalidDestinationCount: number;
  maxTransferAmount: string;
  maxDailyAmount: string;
  selectedOperationRules: OperationRuleId[];
  selectedApprovalRules: ApprovalRuleId[];
  approvalTransferAmount: string;
}) {
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
  if (category.id === "operations") {
    value = formatOptionTitles(selectedOperationRules, OPERATION_RULE_OPTIONS);
  }
  if (category.id === "approvals") {
    const approvalValue = formatOptionTitles(selectedApprovalRules, APPROVAL_RULE_OPTIONS);
    value =
      selectedApprovalRules.includes("large_transfers") && approvalTransferAmount
        ? `${approvalValue} / amount ${approvalTransferAmount}`
        : approvalValue;
  }

  return (
    <div className="border-t border-border-light p-4 first:border-t-0">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm font-semibold text-text-extra-high">{category.title}</p>
        <p className="shrink-0 text-xs text-text-extra-low">
          {category.availability === "live" ? "Applies now" : "Saved for later"}
        </p>
      </div>
      <p className="mt-1 text-sm leading-6 text-text-medium">{value}</p>
      {category.availability === "next" ? (
        <p className="mt-1 text-xs leading-5 text-text-extra-low">
          This rule is configured here but not written by the current payment policy endpoint.
        </p>
      ) : null}
    </div>
  );
}
