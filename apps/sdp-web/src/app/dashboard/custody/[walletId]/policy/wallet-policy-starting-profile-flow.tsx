"use client";

import type { PaymentWalletPolicy } from "@sdp/types";
import { ArrowLeft, ArrowRight, Check, ChevronDown } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { updateWalletPolicy } from "@/app/dashboard/payments/payments-workspace.data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type FlowStep = "intent" | "details" | "review";
type RestrictionCategoryId = "destinations" | "limits";

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
    id: "intent",
    label: "Intent",
    title: "Set wallet policies",
    description: "Choose where funds can go and how much this wallet can transfer.",
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
    description: "Review the changes before applying wallet controls.",
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
  },
  {
    id: "limits",
    title: "Transfer limits",
    description: "Use when this wallet needs spend caps or daily outflow limits.",
  },
] as const satisfies readonly RestrictionCategory[];

const RESTRICTION_CATEGORY_IDS = RESTRICTION_CATEGORIES.map((category) => category.id);

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
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
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
  const trimmedValue = value.trim();
  return trimmedValue === "" || (/^\d+(\.\d+)?$/.test(trimmedValue) && Number(trimmedValue) > 0);
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

function readStoredDraft(walletId: string): StoredPolicyDraft | null {
  try {
    const raw = window.localStorage.getItem(draftStorageKey(walletId));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredDraft(parsed)) return null;

    const draftCategories = filterKnownValues(parsed.categories, RESTRICTION_CATEGORY_IDS);
    if (parsed.status === "draft" && draftCategories.length === 0) {
      window.localStorage.removeItem(draftStorageKey(walletId));
      return null;
    }

    return {
      ...parsed,
      categories: draftCategories,
    };
  } catch {
    return null;
  }
}

function toggleValue<TValue extends string>(values: TValue[], value: TValue): TValue[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getWalletDetailHref(pathname: string, walletId: string): string {
  const section = pathname.startsWith("/dashboard/custody/") ? "custody" : "wallets";
  return `/dashboard/${section}/${encodeURIComponent(walletId)}`;
}

function getPolicyFlowValidationState({
  selectedCategories,
  selectedCategorySet,
  destinationParse,
  maxTransferAmount,
  maxDailyAmount,
  isSubmitting,
  policyError,
}: {
  selectedCategories: RestrictionCategoryId[];
  selectedCategorySet: ReadonlySet<RestrictionCategoryId>;
  destinationParse: ReturnType<typeof parseDestinationText>;
  maxTransferAmount: string;
  maxDailyAmount: string;
  isSubmitting: boolean;
  policyError: string | null;
}) {
  const hasDestinationRule = selectedCategorySet.has("destinations");
  const hasLimitRule = selectedCategorySet.has("limits");
  const hasLimitAmount = Boolean(maxTransferAmount.trim() || maxDailyAmount.trim());
  const canActivateDestinations =
    !hasDestinationRule ||
    (destinationParse.addresses.length > 0 && destinationParse.invalid.length === 0);
  const canActivateLimits =
    !hasLimitRule ||
    (hasLimitAmount && isPositiveAmount(maxTransferAmount) && isPositiveAmount(maxDailyAmount));
  const hasActivatableRestriction =
    (hasDestinationRule && destinationParse.addresses.length > 0) ||
    (hasLimitRule && hasLimitAmount);
  const canSubmit =
    selectedCategories.length > 0 &&
    hasActivatableRestriction &&
    canActivateDestinations &&
    canActivateLimits &&
    !isSubmitting &&
    !policyError;

  return {
    canActivateDestinations,
    canActivateLimits,
    canActivate: canSubmit,
    canSubmitReview: canSubmit,
  };
}

export function WalletPolicyStartingProfileFlow({
  wallet,
  initialPolicy,
  policyError,
}: WalletPolicyStartingProfileFlowProps) {
  const router = useRouter();
  const pathname = usePathname();
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
  const [savedDraft, setSavedDraft] = useState<StoredPolicyDraft | null>(null);
  const [localStatus, setLocalStatus] = useState<"draft" | "disabled" | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const draft = readStoredDraft(wallet.walletId);
    if (draft) {
      setSavedDraft(draft);
      setLocalStatus(draft.status);
      setSelectedCategories(draft.categories);
      setExpandedRuleIds(draft.categories);
      setDestinationText(draft.destinationAllowlist.join("\n"));
      setMaxTransferAmount(draft.maxTransferAmount);
      setMaxDailyAmount(draft.maxDailyAmount);
      const draftStepIndex = FLOW_STEPS.findIndex((step) => step.id === draft.step);
      setStepIndex(Math.max(0, draftStepIndex));
    }
    setIsLoaded(true);
  }, [wallet.walletId]);

  const currentStep = FLOW_STEPS[stepIndex] ?? FLOW_STEPS[0];
  const selectedCategorySet = useMemo(() => new Set(selectedCategories), [selectedCategories]);
  const expandedRuleSet = useMemo(() => new Set(expandedRuleIds), [expandedRuleIds]);
  const destinationParse = useMemo(() => parseDestinationText(destinationText), [destinationText]);
  const hasLivePolicy = policyHasRestrictions(currentPolicy);
  const walletDetailHref = getWalletDetailHref(pathname, wallet.walletId);
  const { canActivateDestinations, canActivateLimits, canActivate, canSubmitReview } =
    getPolicyFlowValidationState({
      selectedCategories,
      selectedCategorySet,
      destinationParse,
      maxTransferAmount,
      maxDailyAmount,
      isSubmitting,
      policyError,
    });

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

    try {
      window.localStorage.setItem(draftStorageKey(wallet.walletId), JSON.stringify(draft));
      setSavedDraft(draft);
      setLocalStatus("draft");
    } catch {
      setSavedDraft(null);
      setLocalStatus(null);
      toast.error("Draft could not be saved.", {
        description: "You can keep configuring, but changes may be lost if you leave.",
        position: "bottom-right",
      });
      return;
    }

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

    persistDraft();

    setStepIndex((current) => Math.min(current + 1, FLOW_STEPS.length - 1));
  }

  function goBack() {
    if (stepIndex === 0) {
      router.push(walletDetailHref);
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
      clearDraft();

      toast.success("Wallet controls active.", {
        id: toastId,
        description: "The selected restrictions are now active.",
        position: "bottom-right",
      });

      if (!hasLivePolicy) {
        router.replace(walletDetailHref);
      }
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
        updatedAt: new Date().toISOString(),
      };

      setCurrentPolicy(updated);
      setSelectedCategories([]);
      setDestinationText("");
      setMaxTransferAmount("");
      setMaxDailyAmount("");
      setExpandedRuleIds([]);
      setSavedDraft(disabledDraft);
      setLocalStatus("disabled");
      setStepIndex(0);
      try {
        window.localStorage.setItem(
          draftStorageKey(wallet.walletId),
          JSON.stringify(disabledDraft)
        );
      } catch {
        // The backend policy is already disabled; keep the UI in sync even if local storage is full.
      }

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
          />
        ) : null}
        {isLoaded && currentStep.id === "review" ? (
          <ReviewStep
            selectedCategories={selectedCategories}
            destinationCount={destinationParse.addresses.length}
            invalidDestinationCount={destinationParse.invalid.length}
            maxTransferAmount={maxTransferAmount.trim()}
            maxDailyAmount={maxDailyAmount.trim()}
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
            {currentStep.id === "review" ? "Apply controls" : "Continue"}
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
}) {
  const selected = RESTRICTION_CATEGORIES.filter((category) =>
    selectedCategories.includes(category.id)
  );

  return (
    <div className="border-y border-border-light">
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
        className="flex w-full items-start justify-between gap-4 py-3.5 pr-2 text-left"
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
      {expanded ? <div className="pb-4 pr-2">{children}</div> : null}
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
        className="mt-2 min-h-[128px] w-full resize-y rounded-lg border border-border-light bg-white px-3 py-3 font-mono text-sm text-text-extra-high outline-none transition-colors placeholder:text-text-extra-low focus:border-gray-1400"
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
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-2" htmlFor="wallet-policy-max-transfer-amount">
          <span className="text-sm font-medium text-text-extra-high">Per transfer cap</span>
          <Input
            id="wallet-policy-max-transfer-amount"
            value={maxTransferAmount}
            onChange={(event) => setMaxTransferAmount(event.target.value)}
            placeholder="1000"
            inputMode="decimal"
          />
          {!isPositiveAmount(maxTransferAmount) ? (
            <span className="block text-sm text-status-error-text">Enter a positive number.</span>
          ) : null}
        </label>
        <label className="space-y-2" htmlFor="wallet-policy-max-daily-amount">
          <span className="text-sm font-medium text-text-extra-high">Daily cap</span>
          <Input
            id="wallet-policy-max-daily-amount"
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

function getRuleSummary({
  categoryId,
  destinationCount,
  maxTransferAmount,
  maxDailyAmount,
}: {
  categoryId: RestrictionCategoryId;
  destinationCount: number;
  maxTransferAmount: string;
  maxDailyAmount: string;
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

  return "";
}

function ReviewStep({
  selectedCategories,
  destinationCount,
  invalidDestinationCount,
  maxTransferAmount,
  maxDailyAmount,
}: {
  selectedCategories: RestrictionCategoryId[];
  destinationCount: number;
  invalidDestinationCount: number;
  maxTransferAmount: string;
  maxDailyAmount: string;
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
            />
          ))
        ) : (
          <div className="p-4 text-sm text-text-medium">No restriction category selected.</div>
        )}
      </div>
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
  let value = "";
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
    <div className="border-t border-border-light p-4 first:border-t-0">
      <p className="text-sm font-semibold text-text-extra-high">{category.title}</p>
      <p className="mt-1 text-sm leading-6 text-text-medium">{value}</p>
    </div>
  );
}
