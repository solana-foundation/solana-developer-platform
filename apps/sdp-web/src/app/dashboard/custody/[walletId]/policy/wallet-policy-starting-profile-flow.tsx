"use client";

import type {
  PaymentWalletPolicy,
  PolicyDefaultAction,
  PolicyRule,
  WalletOperationFamily,
} from "@sdp/types";
import { ArrowLeft, ArrowRight, Check, ChevronDown } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { updateWalletPolicy } from "@/app/dashboard/payments/payments-workspace.data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";

type FlowStep = "intent" | "details" | "review";
type RestrictionCategoryId = "operations" | "destinations" | "limits" | "approvals" | "advanced";
type AdvancedFamily = Extract<WalletOperationFamily, "raw_sign" | "program">;

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
  titleKey: MessageKey;
  descriptionKey: MessageKey;
}

interface StoredPolicyDraft {
  status: "draft" | "disabled";
  step: FlowStep;
  categories: RestrictionCategoryId[];
  blockedOperationFamilies: WalletOperationFamily[];
  destinationAllowlist: string[];
  maxTransferAmount: string;
  maxDailyAmount: string;
  approvalFamilies: WalletOperationFamily[];
  advancedDeniedFamilies: AdvancedFamily[];
  updatedAt: string;
}

type PolicyAudit = NonNullable<PaymentWalletPolicy["audit"]>;
type PolicyAuditEntry = PolicyAudit["recentEvaluations"][number];

const FLOW_STEPS = [
  {
    id: "intent",
    labelKey: "DashboardCustody.policyIntent",
    titleKey: "DashboardCustody.policySetWalletPolicies",
    descriptionKey: "DashboardCustody.policyIntentDescription",
  },
  {
    id: "details",
    labelKey: "DashboardCustody.policyRules",
    titleKey: "DashboardCustody.policyStartingRules",
    descriptionKey: "DashboardCustody.policyRulesDescription",
  },
  {
    id: "review",
    labelKey: "DashboardCustody.policyReview",
    titleKey: "DashboardCustody.policyFinalReview",
    descriptionKey: "DashboardCustody.policyReviewDescription",
  },
] as const satisfies readonly {
  id: FlowStep;
  labelKey: MessageKey;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
}[];

const RESTRICTION_CATEGORIES = [
  {
    id: "operations",
    titleKey: "DashboardCustody.policyOperationAccess",
    descriptionKey: "DashboardCustody.policyOperationAccessDescription",
  },
  {
    id: "destinations",
    titleKey: "DashboardCustody.policyAllowedDestinations",
    descriptionKey: "DashboardCustody.policyAllowedDestinationsDescription",
  },
  {
    id: "limits",
    titleKey: "DashboardCustody.policyTransferLimits",
    descriptionKey: "DashboardCustody.policyTransferLimitsDescription",
  },
  {
    id: "approvals",
    titleKey: "DashboardCustody.policyApprovalChecks",
    descriptionKey: "DashboardCustody.policyApprovalChecksDescription",
  },
  {
    id: "advanced",
    titleKey: "DashboardCustody.policyAdvancedSigning",
    descriptionKey: "DashboardCustody.policyAdvancedSigningDescription",
  },
] as const satisfies readonly RestrictionCategory[];

const RESTRICTION_CATEGORY_IDS = RESTRICTION_CATEGORIES.map((category) => category.id);
const DEFAULT_POLICY_ACTION = "allow" satisfies PolicyDefaultAction;
const OPERATION_FAMILY_OPTIONS = [
  { id: "payment", labelKey: "DashboardCustody.policyPayments" },
  { id: "transfer", labelKey: "DashboardCustody.transfers" },
  { id: "ramp", labelKey: "DashboardCustody.policyRamps" },
  { id: "issuance", labelKey: "DashboardCustody.policyIssuance" },
  { id: "provider_admin", labelKey: "DashboardCustody.policyProviderAdmin" },
] as const satisfies readonly { id: WalletOperationFamily; labelKey: MessageKey }[];
const APPROVAL_FAMILY_OPTIONS = [
  { id: "payment", labelKey: "DashboardCustody.policyPayments" },
  { id: "ramp", labelKey: "DashboardCustody.policyRamps" },
  { id: "issuance", labelKey: "DashboardCustody.policyIssuance" },
  { id: "raw_sign", labelKey: "DashboardCustody.policyRawSigning" },
  { id: "program", labelKey: "DashboardCustody.policyProgramInteractions" },
] as const satisfies readonly { id: WalletOperationFamily; labelKey: MessageKey }[];
const ADVANCED_FAMILY_OPTIONS = [
  { id: "raw_sign", labelKey: "DashboardCustody.policyRawSigning" },
  { id: "program", labelKey: "DashboardCustody.policyProgramInteractions" },
] as const satisfies readonly { id: AdvancedFamily; labelKey: MessageKey }[];

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
    Boolean(policy.maxDailyAmount) ||
    Boolean(policy.rules?.length)
  );
}

function categoriesFromPolicy(policy: PaymentWalletPolicy): RestrictionCategoryId[] {
  const categories: RestrictionCategoryId[] = [];
  const blockedFamilies = blockedOperationFamiliesFromRules(policy.rules ?? []);
  const approvalFamilies = approvalFamiliesFromRules(policy.rules ?? []);
  const advancedFamilies = advancedDeniedFamiliesFromRules(policy.rules ?? []);
  if (blockedFamilies.length > 0) categories.push("operations");
  if (policy.destinationAllowlist.length > 0) categories.push("destinations");
  if (policy.maxTransferAmount || policy.maxDailyAmount) categories.push("limits");
  if (approvalFamilies.length > 0) categories.push("approvals");
  if (advancedFamilies.length > 0) categories.push("advanced");
  return categories;
}

function blockedOperationFamiliesFromRules(rules: PolicyRule[]): WalletOperationFamily[] {
  return uniqueValues(
    rules
      .filter(
        (rule): rule is Extract<PolicyRule, { kind: "operation_family" }> =>
          rule.kind === "operation_family" && rule.action === "deny"
      )
      .flatMap((rule) => rule.families ?? (rule.family ? [rule.family] : []))
      .filter((family) => family !== "raw_sign" && family !== "program")
  ) as WalletOperationFamily[];
}

function advancedDeniedFamiliesFromRules(rules: PolicyRule[]): AdvancedFamily[] {
  return uniqueValues(
    rules
      .filter(
        (rule): rule is Extract<PolicyRule, { kind: "operation_family" }> =>
          rule.kind === "operation_family" && rule.action === "deny"
      )
      .flatMap(advancedDeniedFamiliesFromOperationRule)
  ) as AdvancedFamily[];
}

function advancedDeniedFamiliesFromOperationRule(
  rule: Extract<PolicyRule, { kind: "operation_family" }>
): AdvancedFamily[] {
  return (rule.families ?? (rule.family ? [rule.family] : [])).filter(
    (family): family is AdvancedFamily => family === "raw_sign" || family === "program"
  );
}

function approvalFamiliesFromRules(rules: PolicyRule[]): WalletOperationFamily[] {
  return uniqueValues(
    rules
      .filter((rule): rule is Extract<PolicyRule, { kind: "approval" }> => rule.kind === "approval")
      .flatMap((rule) => rule.families ?? [])
  ) as WalletOperationFamily[];
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

function formatDateTime(value: string, t?: ReturnType<typeof useTranslations>): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t?.("DashboardCustody.savedDraft") ?? "Saved draft";
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
    Array.isArray(draft.blockedOperationFamilies) &&
    Array.isArray(draft.destinationAllowlist) &&
    typeof draft.maxTransferAmount === "string" &&
    typeof draft.maxDailyAmount === "string" &&
    Array.isArray(draft.approvalFamilies) &&
    Array.isArray(draft.advancedDeniedFamilies) &&
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
      blockedOperationFamilies: filterKnownValues(
        parsed.blockedOperationFamilies,
        OPERATION_FAMILY_OPTIONS.map((option) => option.id)
      ),
      approvalFamilies: filterKnownValues(
        parsed.approvalFamilies,
        APPROVAL_FAMILY_OPTIONS.map((option) => option.id)
      ),
      advancedDeniedFamilies: filterKnownValues(
        parsed.advancedDeniedFamilies,
        ADVANCED_FAMILY_OPTIONS.map((option) => option.id)
      ),
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

function formatFamilyLabel(
  family: WalletOperationFamily,
  t?: ReturnType<typeof useTranslations>
): string {
  const match = [...OPERATION_FAMILY_OPTIONS, ...APPROVAL_FAMILY_OPTIONS].find(
    (option) => option.id === family
  );
  return match ? (t ? t(match.labelKey) : match.labelKey) : family.replaceAll("_", " ");
}

function formatFamilyList(
  families: readonly WalletOperationFamily[],
  t?: ReturnType<typeof useTranslations>
): string {
  return families.map((family) => formatFamilyLabel(family, t)).join(", ");
}

function formatPolicyDecision(
  decision: PolicyAuditEntry["decision"],
  t: ReturnType<typeof useTranslations>
): string {
  const labels = {
    allow: "DashboardCustody.policyAllowed",
    deny: "DashboardCustody.policyDenied",
    approval_required: "DashboardCustody.policyApprovalRequired",
    provider_approval_required: "DashboardCustody.policyProviderApprovalRequired",
    review: "DashboardCustody.policyReview",
    not_evaluated: "DashboardCustody.policyNotEvaluated",
  } satisfies Record<PolicyAuditEntry["decision"], MessageKey>;
  return t(labels[decision]);
}

function formatPolicyStatus(
  status: PolicyAuditEntry["status"],
  t: ReturnType<typeof useTranslations>
): string {
  return status.replaceAll("_", " ");
}

function formatPolicyAuditOperation(
  entry: PolicyAuditEntry,
  t: ReturnType<typeof useTranslations>
): string {
  const operation = `${formatFamilyLabel(entry.operationFamily, t)} / ${entry.operationType.replaceAll("_", " ")}`;
  const amount = [entry.amount, entry.asset].filter(Boolean).join(" ");
  return amount ? `${operation} / ${amount}` : operation;
}

function getWalletDetailHref(pathname: string, walletId: string): string {
  const section = pathname.startsWith("/dashboard/custody/") ? "custody" : "wallets";
  return `/dashboard/${section}/${encodeURIComponent(walletId)}`;
}

function getPolicyFlowValidationState({
  selectedCategories,
  selectedCategorySet,
  blockedOperationFamilies,
  destinationParse,
  maxTransferAmount,
  maxDailyAmount,
  approvalFamilies,
  advancedDeniedFamilies,
  isSubmitting,
  policyError,
}: {
  selectedCategories: RestrictionCategoryId[];
  selectedCategorySet: ReadonlySet<RestrictionCategoryId>;
  blockedOperationFamilies: WalletOperationFamily[];
  destinationParse: ReturnType<typeof parseDestinationText>;
  maxTransferAmount: string;
  maxDailyAmount: string;
  approvalFamilies: WalletOperationFamily[];
  advancedDeniedFamilies: AdvancedFamily[];
  isSubmitting: boolean;
  policyError: string | null;
}) {
  const hasOperationRule = selectedCategorySet.has("operations");
  const hasDestinationRule = selectedCategorySet.has("destinations");
  const hasLimitRule = selectedCategorySet.has("limits");
  const hasApprovalRule = selectedCategorySet.has("approvals");
  const hasAdvancedRule = selectedCategorySet.has("advanced");
  const hasLimitAmount = Boolean(maxTransferAmount.trim() || maxDailyAmount.trim());
  const canActivateOperations = !hasOperationRule || blockedOperationFamilies.length > 0;
  const canActivateDestinations =
    !hasDestinationRule ||
    (destinationParse.addresses.length > 0 && destinationParse.invalid.length === 0);
  const canActivateLimits =
    !hasLimitRule ||
    (hasLimitAmount && isPositiveAmount(maxTransferAmount) && isPositiveAmount(maxDailyAmount));
  const canActivateApprovals = !hasApprovalRule || approvalFamilies.length > 0;
  const canActivateAdvanced = !hasAdvancedRule || advancedDeniedFamilies.length > 0;
  const hasActivatableRestriction =
    (hasOperationRule && blockedOperationFamilies.length > 0) ||
    (hasDestinationRule && destinationParse.addresses.length > 0) ||
    (hasLimitRule && hasLimitAmount) ||
    (hasApprovalRule && approvalFamilies.length > 0) ||
    (hasAdvancedRule && advancedDeniedFamilies.length > 0);
  const canSubmit =
    selectedCategories.length > 0 &&
    hasActivatableRestriction &&
    canActivateOperations &&
    canActivateDestinations &&
    canActivateLimits &&
    canActivateApprovals &&
    canActivateAdvanced &&
    !isSubmitting &&
    !policyError;

  return {
    canActivateOperations,
    canActivateDestinations,
    canActivateLimits,
    canActivateApprovals,
    canActivateAdvanced,
    canActivate: canSubmit,
    canSubmitReview: canSubmit,
  };
}

function buildPolicyRules({
  selectedCategorySet,
  blockedOperationFamilies,
  destinationAllowlist,
  maxTransferAmount,
  approvalFamilies,
  advancedDeniedFamilies,
  t,
}: {
  selectedCategorySet: ReadonlySet<RestrictionCategoryId>;
  blockedOperationFamilies: WalletOperationFamily[];
  destinationAllowlist: string[];
  maxTransferAmount: string;
  approvalFamilies: WalletOperationFamily[];
  advancedDeniedFamilies: AdvancedFamily[];
  t: ReturnType<typeof useTranslations>;
}): PolicyRule[] {
  const rules: PolicyRule[] = [];

  if (selectedCategorySet.has("operations")) {
    for (const family of blockedOperationFamilies) {
      rules.push({
        id: `deny-${family}`,
        kind: "operation_family",
        family,
        action: "deny",
        name: t("DashboardCustody.policyBlockFamilies", { families: formatFamilyLabel(family, t) }),
      });
    }
  }

  if (selectedCategorySet.has("destinations") && destinationAllowlist.length > 0) {
    rules.push({
      id: "allowed-destinations",
      kind: "destination",
      allowlist: destinationAllowlist,
      action: "allow",
      name: t("DashboardCustody.policyRuleAllowedDestinations"),
    });
  }

  if (selectedCategorySet.has("limits") && maxTransferAmount) {
    rules.push({
      id: "per-transfer-limit",
      kind: "amount",
      max: maxTransferAmount,
      action: "allow",
      name: t("DashboardCustody.policyRulePerTransferLimit"),
    });
  }

  if (selectedCategorySet.has("approvals") && approvalFamilies.length > 0) {
    rules.push({
      id: "approval-required",
      kind: "approval",
      families: approvalFamilies,
      action: "approval_required",
      name: t("DashboardCustody.policyRuleApprovalChecks"),
    });
  }

  if (selectedCategorySet.has("advanced")) {
    for (const family of advancedDeniedFamilies) {
      rules.push({
        id: `deny-${family}`,
        kind: "operation_family",
        family,
        action: "deny",
        name: t("DashboardCustody.policyBlockFamilies", { families: formatFamilyLabel(family, t) }),
      });
    }
  }

  return rules;
}

export function WalletPolicyStartingProfileFlow({
  wallet,
  initialPolicy,
  policyError,
}: WalletPolicyStartingProfileFlowProps) {
  const t = useTranslations();
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
  const [blockedOperationFamilies, setBlockedOperationFamilies] = useState<WalletOperationFamily[]>(
    blockedOperationFamiliesFromRules(initialPolicy.rules ?? [])
  );
  const [destinationText, setDestinationText] = useState(
    initialPolicy.destinationAllowlist.join("\n")
  );
  const [maxTransferAmount, setMaxTransferAmount] = useState(initialPolicy.maxTransferAmount ?? "");
  const [maxDailyAmount, setMaxDailyAmount] = useState(initialPolicy.maxDailyAmount ?? "");
  const [approvalFamilies, setApprovalFamilies] = useState<WalletOperationFamily[]>(
    approvalFamiliesFromRules(initialPolicy.rules ?? [])
  );
  const [advancedDeniedFamilies, setAdvancedDeniedFamilies] = useState<AdvancedFamily[]>(
    advancedDeniedFamiliesFromRules(initialPolicy.rules ?? [])
  );
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
      setBlockedOperationFamilies(draft.blockedOperationFamilies);
      setDestinationText(draft.destinationAllowlist.join("\n"));
      setMaxTransferAmount(draft.maxTransferAmount);
      setMaxDailyAmount(draft.maxDailyAmount);
      setApprovalFamilies(draft.approvalFamilies);
      setAdvancedDeniedFamilies(draft.advancedDeniedFamilies);
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
  const {
    canActivateOperations,
    canActivateDestinations,
    canActivateLimits,
    canActivateApprovals,
    canActivateAdvanced,
    canActivate,
    canSubmitReview,
  } = getPolicyFlowValidationState({
    selectedCategories,
    selectedCategorySet,
    blockedOperationFamilies,
    destinationParse,
    maxTransferAmount,
    maxDailyAmount,
    approvalFamilies,
    advancedDeniedFamilies,
    isSubmitting,
    policyError,
  });

  function persistDraft(options: { notify: boolean } = { notify: false }) {
    if (typeof window === "undefined") return;

    const draft: StoredPolicyDraft = {
      status: "draft",
      step: currentStep.id,
      categories: selectedCategories,
      blockedOperationFamilies,
      destinationAllowlist: destinationParse.addresses,
      maxTransferAmount: maxTransferAmount.trim(),
      maxDailyAmount: maxDailyAmount.trim(),
      approvalFamilies,
      advancedDeniedFamilies,
      updatedAt: new Date().toISOString(),
    };

    try {
      window.localStorage.setItem(draftStorageKey(wallet.walletId), JSON.stringify(draft));
      setSavedDraft(draft);
      setLocalStatus("draft");
    } catch {
      setSavedDraft(null);
      setLocalStatus(null);
      toast.error(t("DashboardCustody.policyDraftSaveFailed"), {
        description: t("DashboardCustody.policyDraftSaveFailedDescription"),
        position: "bottom-right",
      });
      return;
    }

    if (options.notify) {
      toast.success(t("DashboardCustody.policyDraftSaved"), {
        description: t("DashboardCustody.policyDraftSavedDescription"),
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
      toast.error(t("DashboardCustody.policyChooseRestriction"), {
        position: "bottom-right",
      });
      return;
    }

    if (currentStep.id === "details") {
      if (!canActivateDestinations) {
        toast.error(t("DashboardCustody.policyCheckDestinations"), {
          description: t("DashboardCustody.policyCheckDestinationsDescription"),
          position: "bottom-right",
        });
        return;
      }
      if (!canActivateOperations) {
        toast.error(t("DashboardCustody.policyChooseOperations"), {
          description: t("DashboardCustody.policyChooseOperationsDescription"),
          position: "bottom-right",
        });
        return;
      }
      if (!canActivateLimits) {
        toast.error(t("DashboardCustody.policyCheckLimits"), {
          description: t("DashboardCustody.policyCheckLimitsDescription"),
          position: "bottom-right",
        });
        return;
      }
      if (!canActivateApprovals) {
        toast.error(t("DashboardCustody.policyChooseApprovals"), {
          description: t("DashboardCustody.policyChooseApprovalsDescription"),
          position: "bottom-right",
        });
        return;
      }
      if (!canActivateAdvanced) {
        toast.error(t("DashboardCustody.policyChooseAdvanced"), {
          description: t("DashboardCustody.policyChooseAdvancedDescription"),
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
    const toastId = toast.loading(t("DashboardCustody.policyActivating"), {
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
        defaultAction: DEFAULT_POLICY_ACTION,
        rules: buildPolicyRules({
          selectedCategorySet,
          blockedOperationFamilies,
          destinationAllowlist: destinationParse.addresses,
          maxTransferAmount: maxTransferAmount.trim(),
          approvalFamilies,
          advancedDeniedFamilies,
          t,
        }),
      });

      setCurrentPolicy(updated);
      clearDraft();

      toast.success(t("DashboardCustody.policyActive"), {
        id: toastId,
        description: t("DashboardCustody.policyActiveDescription"),
        position: "bottom-right",
      });

      if (!hasLivePolicy) {
        router.replace(walletDetailHref);
      }
    } catch (error) {
      toast.error(t("DashboardCustody.policyActivationFailed"), {
        id: toastId,
        description: error instanceof Error ? error.message : t("DashboardCustody.policySaveFailed"),
        position: "bottom-right",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function disableProfile() {
    setIsSubmitting(true);
    const toastId = toast.loading(t("DashboardCustody.policyDisabling"), {
      position: "bottom-right",
    });
    try {
      const updated = await updateWalletPolicy(wallet.walletId, {
        walletId: wallet.walletId,
        destinationAllowlist: [],
        defaultAction: DEFAULT_POLICY_ACTION,
        rules: [],
      });

      const disabledDraft: StoredPolicyDraft = {
        status: "disabled",
        step: "intent",
        categories: [],
        blockedOperationFamilies: [],
        destinationAllowlist: [],
        maxTransferAmount: "",
        maxDailyAmount: "",
        approvalFamilies: [],
        advancedDeniedFamilies: [],
        updatedAt: new Date().toISOString(),
      };

      setCurrentPolicy(updated);
      setSelectedCategories([]);
      setBlockedOperationFamilies([]);
      setDestinationText("");
      setMaxTransferAmount("");
      setMaxDailyAmount("");
      setApprovalFamilies([]);
      setAdvancedDeniedFamilies([]);
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

      toast.success(t("DashboardCustody.policyDisabled"), {
        id: toastId,
        description: t("DashboardCustody.policyDisabledDescription"),
        position: "bottom-right",
      });
    } catch (error) {
      toast.error(t("DashboardCustody.policyDisableFailed"), {
        id: toastId,
        description: error instanceof Error ? error.message : t("DashboardCustody.policySaveFailed"),
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
        <h1 className="text-2xl font-medium text-text-extra-high">{t(currentStep.titleKey)}</h1>
        <p className="text-sm text-text-medium">{t(currentStep.descriptionKey)}</p>
        {savedDraft?.updatedAt && localStatus === "draft" ? (
          <p className="pt-1 text-xs text-text-extra-low">
            {t("DashboardCustody.policyDraftSaved")} {formatDateTime(savedDraft.updatedAt, t)}
          </p>
        ) : null}
      </div>

      {policyError ? (
        <div className="mt-4 rounded-md border border-status-error-border bg-status-error-bg px-3 py-2 text-sm text-status-error-text">
          {policyError}
        </div>
      ) : null}

      <div className="mt-6 min-h-0 flex-1 overflow-y-auto px-1 py-1">
        <PolicyAuditPanel audit={currentPolicy.audit ?? null} />
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
            blockedOperationFamilies={blockedOperationFamilies}
            setBlockedOperationFamilies={setBlockedOperationFamilies}
            approvalFamilies={approvalFamilies}
            setApprovalFamilies={setApprovalFamilies}
            advancedDeniedFamilies={advancedDeniedFamilies}
            setAdvancedDeniedFamilies={setAdvancedDeniedFamilies}
          />
        ) : null}
        {isLoaded && currentStep.id === "review" ? (
          <ReviewStep
            selectedCategories={selectedCategories}
            blockedOperationFamilies={blockedOperationFamilies}
            destinationCount={destinationParse.addresses.length}
            invalidDestinationCount={destinationParse.invalid.length}
            maxTransferAmount={maxTransferAmount.trim()}
            maxDailyAmount={maxDailyAmount.trim()}
            approvalFamilies={approvalFamilies}
            advancedDeniedFamilies={advancedDeniedFamilies}
            controlProfile={currentPolicy.controlProfile ?? null}
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
            {stepIndex === 0 ? t("DashboardCustody.back") : t("DashboardCustody.previous")}
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
              {t("DashboardCustody.policyDisable")}
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
            {currentStep.id === "review" ? t("DashboardCustody.policyApplyControls") : t("DashboardCustody.continue")}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function PolicyAuditPanel({ audit }: { audit: PolicyAudit | null }) {
  const t = useTranslations();
  const evaluations = audit?.recentEvaluations.slice(0, 5) ?? [];
  if (evaluations.length === 0) return null;

  return (
    <section className="mb-4 rounded-lg border border-border-light bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-extra-high">{t("DashboardCustody.recentPolicyDecisions")}</h2>
          <p className="mt-1 text-xs text-text-extra-low">
            {t("DashboardCustody.policyEvaluationsShown", { count: evaluations.length })}
          </p>
        </div>
      </div>

      <div className="mt-3 divide-y divide-border-light">
        {evaluations.map((entry) => (
          <div key={entry.policyEvaluationId} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold text-text-extra-high">
                {formatPolicyDecision(entry.decision, t)}
              </span>
              <span className="rounded-full bg-border-extra-light px-2 py-0.5 text-text-medium">
                {formatPolicyStatus(entry.status, t)}
              </span>
              {entry.requiresApproval ? (
                <span className="rounded-full bg-status-warning-bg px-2 py-0.5 text-status-warning-text">
                  {t("DashboardCustody.needsApproval")}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm leading-5 text-text-medium">
              {formatPolicyAuditOperation(entry, t)}
            </p>
            <p className="mt-1 text-xs leading-5 text-text-medium">
              {entry.reason ?? entry.reasonCode}
            </p>
            <p className="mt-1 text-xs text-text-extra-low">
              {formatDateTime(entry.evaluatedAt, t)}
              {entry.approvalRequestId
                ? t("DashboardCustody.policyApprovalRequest", { id: entry.approvalRequestId })
                : ""}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function StepIndicator({ stepIndex }: { stepIndex: number }) {
  const t = useTranslations();
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
        {t("DashboardCustody.stepOf", { current: stepIndex + 1, total: FLOW_STEPS.length })}
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
  const t = useTranslations();
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
            <p className="text-base font-semibold text-text-extra-high">{t(category.titleKey)}</p>
            <p className="mt-2 text-sm leading-6 text-text-medium">{t(category.descriptionKey)}</p>
            {selected ? (
              <span className="absolute right-4 bottom-4 flex size-6 items-center justify-center rounded-full bg-gray-1400 text-white">
                <Check className="size-4" />
                <span className="sr-only">{t("DashboardCustody.selected")}</span>
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
  blockedOperationFamilies,
  setBlockedOperationFamilies,
  destinationText,
  setDestinationText,
  destinationCount,
  invalidDestinations,
  maxTransferAmount,
  setMaxTransferAmount,
  maxDailyAmount,
  setMaxDailyAmount,
  approvalFamilies,
  setApprovalFamilies,
  advancedDeniedFamilies,
  setAdvancedDeniedFamilies,
}: {
  selectedCategories: RestrictionCategoryId[];
  expandedRuleSet: Set<RestrictionCategoryId>;
  onToggleExpandedRule: (category: RestrictionCategoryId) => void;
  blockedOperationFamilies: WalletOperationFamily[];
  setBlockedOperationFamilies: (value: WalletOperationFamily[]) => void;
  destinationText: string;
  setDestinationText: (value: string) => void;
  destinationCount: number;
  invalidDestinations: string[];
  maxTransferAmount: string;
  setMaxTransferAmount: (value: string) => void;
  maxDailyAmount: string;
  setMaxDailyAmount: (value: string) => void;
  approvalFamilies: WalletOperationFamily[];
  setApprovalFamilies: (value: WalletOperationFamily[]) => void;
  advancedDeniedFamilies: AdvancedFamily[];
  setAdvancedDeniedFamilies: (value: AdvancedFamily[]) => void;
}) {
  const t = useTranslations();
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
              blockedOperationFamilies,
              destinationCount,
              maxTransferAmount,
              maxDailyAmount,
              approvalFamilies,
              advancedDeniedFamilies,
              t,
            })}
            onToggle={() => onToggleExpandedRule(category.id)}
          >
            {category.id === "operations" ? (
              <OperationRuleEditor
                blockedOperationFamilies={blockedOperationFamilies}
                setBlockedOperationFamilies={setBlockedOperationFamilies}
              />
            ) : null}
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
            {category.id === "approvals" ? (
              <ApprovalRuleEditor
                approvalFamilies={approvalFamilies}
                setApprovalFamilies={setApprovalFamilies}
              />
            ) : null}
            {category.id === "advanced" ? (
              <AdvancedRuleEditor
                advancedDeniedFamilies={advancedDeniedFamilies}
                setAdvancedDeniedFamilies={setAdvancedDeniedFamilies}
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
  const t = useTranslations();
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
            {t(category.titleKey)}
          </span>
          <span className="mt-1 block text-sm leading-5 text-text-medium">{summary}</span>
        </span>
        <span className="flex size-6 shrink-0 items-center justify-center text-text-low">
          <ChevronDown
            aria-hidden="true"
            className={cn("size-4 transition-transform duration-200", expanded && "rotate-180")}
          />
          <span className="sr-only">{expanded ? t("DashboardCustody.collapse") : t("DashboardCustody.expand")}</span>
        </span>
      </button>
      {expanded ? <div className="pb-4 pr-2">{children}</div> : null}
    </section>
  );
}

function OptionGrid<TValue extends string>({
  options,
  values,
  onChange,
}: {
  options: readonly { id: TValue; labelKey: MessageKey }[];
  values: TValue[];
  onChange: (value: TValue[]) => void;
}) {
  const t = useTranslations();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const selected = values.includes(option.id);

        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(toggleValue(values, option.id))}
            className={cn(
              "min-h-11 rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors",
              selected
                ? "border-[rgba(28,28,29,0.72)] bg-[rgba(28,28,29,0.04)] text-text-extra-high"
                : "border-border-light bg-white text-text-medium hover:bg-gray-100"
            )}
          >
            {t(option.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

function OperationRuleEditor({
  blockedOperationFamilies,
  setBlockedOperationFamilies,
}: {
  blockedOperationFamilies: WalletOperationFamily[];
  setBlockedOperationFamilies: (value: WalletOperationFamily[]) => void;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-3">
      <p className="text-sm leading-6 text-text-medium">
        {t("DashboardCustody.policyOperationEditorDescription")}
      </p>
      <OptionGrid
        options={OPERATION_FAMILY_OPTIONS}
        values={blockedOperationFamilies}
        onChange={setBlockedOperationFamilies}
      />
    </div>
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
  const t = useTranslations();
  return (
    <div>
      <p className="text-sm leading-6 text-text-medium">
        {t("DashboardCustody.policyDestinationEditorDescription")}
      </p>
      <textarea
        value={destinationText}
        onChange={(event) => setDestinationText(event.target.value)}
        rows={6}
        className="mt-2 min-h-[128px] w-full resize-y rounded-lg border border-border-light bg-white px-3 py-3 font-mono text-sm text-text-extra-high outline-none transition-colors placeholder:text-text-extra-low focus:border-gray-1400"
        placeholder={t("DashboardCustody.policyAddressPlaceholder")}
      />
      {invalidDestinations.length > 0 ? (
        <p className="mt-2 text-sm text-status-error-text">
          {t(
            invalidDestinations.length === 1
              ? "DashboardCustody.policyInvalidAddress"
              : "DashboardCustody.policyInvalidAddresses",
            { addresses: invalidDestinations.join(", ") }
          )}
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
  const t = useTranslations();
  return (
    <div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-2" htmlFor="wallet-policy-max-transfer-amount">
          <span className="text-sm font-medium text-text-extra-high">{t("DashboardCustody.policyPerTransferCap")}</span>
          <Input
            id="wallet-policy-max-transfer-amount"
            value={maxTransferAmount}
            onChange={(event) => setMaxTransferAmount(event.target.value)}
            placeholder="1000"
            inputMode="decimal"
          />
          {!isPositiveAmount(maxTransferAmount) ? (
            <span className="block text-sm text-status-error-text">{t("DashboardCustody.policyPositiveNumber")}</span>
          ) : null}
        </label>
        <label className="space-y-2" htmlFor="wallet-policy-max-daily-amount">
          <span className="text-sm font-medium text-text-extra-high">{t("DashboardCustody.policyDailyCap")}</span>
          <Input
            id="wallet-policy-max-daily-amount"
            value={maxDailyAmount}
            onChange={(event) => setMaxDailyAmount(event.target.value)}
            placeholder="5000"
            inputMode="decimal"
          />
          {!isPositiveAmount(maxDailyAmount) ? (
            <span className="block text-sm text-status-error-text">{t("DashboardCustody.policyPositiveNumber")}</span>
          ) : null}
        </label>
      </div>
    </div>
  );
}

function ApprovalRuleEditor({
  approvalFamilies,
  setApprovalFamilies,
}: {
  approvalFamilies: WalletOperationFamily[];
  setApprovalFamilies: (value: WalletOperationFamily[]) => void;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-3">
      <p className="text-sm leading-6 text-text-medium">
        {t("DashboardCustody.policyApprovalEditorDescription")}
      </p>
      <OptionGrid
        options={APPROVAL_FAMILY_OPTIONS}
        values={approvalFamilies}
        onChange={setApprovalFamilies}
      />
    </div>
  );
}

function AdvancedRuleEditor({
  advancedDeniedFamilies,
  setAdvancedDeniedFamilies,
}: {
  advancedDeniedFamilies: AdvancedFamily[];
  setAdvancedDeniedFamilies: (value: AdvancedFamily[]) => void;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-3">
      <p className="text-sm leading-6 text-text-medium">
        {t("DashboardCustody.policyAdvancedEditorDescription")}
      </p>
      <OptionGrid
        options={ADVANCED_FAMILY_OPTIONS}
        values={advancedDeniedFamilies}
        onChange={setAdvancedDeniedFamilies}
      />
    </div>
  );
}

function getRuleSummary({
  categoryId,
  blockedOperationFamilies,
  destinationCount,
  maxTransferAmount,
  maxDailyAmount,
  approvalFamilies,
  advancedDeniedFamilies,
  t,
}: {
  categoryId: RestrictionCategoryId;
  blockedOperationFamilies: WalletOperationFamily[];
  destinationCount: number;
  maxTransferAmount: string;
  maxDailyAmount: string;
  approvalFamilies: WalletOperationFamily[];
  advancedDeniedFamilies: AdvancedFamily[];
  t: ReturnType<typeof useTranslations>;
}) {
  if (categoryId === "operations") {
    return blockedOperationFamilies.length > 0
      ? t("DashboardCustody.policyBlockFamilies", { families: formatFamilyList(blockedOperationFamilies, t) })
      : t("DashboardCustody.policyChooseOperationFamilies");
  }

  if (categoryId === "destinations") {
    return destinationCount > 0
      ? t("DashboardCustody.policyDestinationCount", { count: destinationCount })
      : t("DashboardCustody.policyPasteAddresses");
  }

  if (categoryId === "limits") {
    const parts = [
      maxTransferAmount.trim() ? t("DashboardCustody.policyPerTransferValue", { value: maxTransferAmount.trim() }) : null,
      maxDailyAmount.trim() ? t("DashboardCustody.policyDailyValue", { value: maxDailyAmount.trim() }) : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" / ") : t("DashboardCustody.policySetCaps");
  }

  if (categoryId === "approvals") {
    return approvalFamilies.length > 0
      ? t("DashboardCustody.policyRequireApprovalFor", { families: formatFamilyList(approvalFamilies, t) })
      : t("DashboardCustody.policyChooseApprovalFamilies");
  }

  if (categoryId === "advanced") {
    return advancedDeniedFamilies.length > 0
      ? t("DashboardCustody.policyBlockFamilies", { families: formatFamilyList(advancedDeniedFamilies, t) })
      : t("DashboardCustody.policyBlockAdvanced");
  }

  return "";
}

function ReviewStep({
  selectedCategories,
  blockedOperationFamilies,
  destinationCount,
  invalidDestinationCount,
  maxTransferAmount,
  maxDailyAmount,
  approvalFamilies,
  advancedDeniedFamilies,
  controlProfile,
}: {
  selectedCategories: RestrictionCategoryId[];
  blockedOperationFamilies: WalletOperationFamily[];
  destinationCount: number;
  invalidDestinationCount: number;
  maxTransferAmount: string;
  maxDailyAmount: string;
  approvalFamilies: WalletOperationFamily[];
  advancedDeniedFamilies: AdvancedFamily[];
  controlProfile: PaymentWalletPolicy["controlProfile"] | null;
}) {
  const t = useTranslations();
  const selected = RESTRICTION_CATEGORIES.filter((category) =>
    selectedCategories.includes(category.id)
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-light bg-white p-4">
        <p className="text-sm font-semibold text-text-extra-high">{t("DashboardCustody.policyActivationOutcome")}</p>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-text-extra-low">{t("DashboardCustody.policyDefault")}</dt>
            <dd className="mt-1 font-medium text-text-extra-high">{t("DashboardCustody.policyAllowUnmatched")}</dd>
          </div>
          <div>
            <dt className="text-text-extra-low">{t("DashboardCustody.policyRevision")}</dt>
            <dd className="mt-1 font-medium text-text-extra-high">
              {controlProfile?.revisionNumber ? `#${controlProfile.revisionNumber}` : t("DashboardCustody.policyRevisionNew")}
            </dd>
          </div>
          <div>
            <dt className="text-text-extra-low">{t("DashboardCustody.policyProviderMapping")}</dt>
            <dd className="mt-1 font-medium text-text-extra-high">
              {controlProfile
                ? formatProviderMappingStatus(controlProfile.providerMappingStatus, t)
                : t("DashboardCustody.policySdpEnforced")}
            </dd>
          </div>
        </dl>
      </div>
      <div className="overflow-hidden rounded-lg border border-border-light bg-white">
        {selected.length > 0 ? (
          selected.map((category) => (
            <ReviewCategory
              key={category.id}
              category={category}
              blockedOperationFamilies={blockedOperationFamilies}
              destinationCount={destinationCount}
              invalidDestinationCount={invalidDestinationCount}
              maxTransferAmount={maxTransferAmount}
              maxDailyAmount={maxDailyAmount}
              approvalFamilies={approvalFamilies}
              advancedDeniedFamilies={advancedDeniedFamilies}
            />
          ))
        ) : (
          <div className="p-4 text-sm text-text-medium">{t("DashboardCustody.policyNoRestrictionCategory")}</div>
        )}
      </div>
    </div>
  );
}

function ReviewCategory({
  category,
  blockedOperationFamilies,
  destinationCount,
  invalidDestinationCount,
  maxTransferAmount,
  maxDailyAmount,
  approvalFamilies,
  advancedDeniedFamilies,
}: {
  category: RestrictionCategory;
  blockedOperationFamilies: WalletOperationFamily[];
  destinationCount: number;
  invalidDestinationCount: number;
  maxTransferAmount: string;
  maxDailyAmount: string;
  approvalFamilies: WalletOperationFamily[];
  advancedDeniedFamilies: AdvancedFamily[];
}) {
  const t = useTranslations();
  let value = "";
  if (category.id === "operations") {
    value =
      blockedOperationFamilies.length > 0
        ? t("DashboardCustody.policyDenyFamilies", { families: formatFamilyList(blockedOperationFamilies, t) })
        : t("DashboardCustody.policyNoOperationsBlocked");
  }
  if (category.id === "destinations") {
    value =
      invalidDestinationCount > 0
        ? t("DashboardCustody.policyInvalidCount", { count: invalidDestinationCount })
        : destinationCount > 0
          ? t("DashboardCustody.policyAllowedCount", { count: destinationCount })
          : t("DashboardCustody.policyNoAddresses");
  }
  if (category.id === "limits") {
    const parts = [
      maxTransferAmount ? t("DashboardCustody.policyPerTransferValue", { value: maxTransferAmount }) : null,
      maxDailyAmount ? t("DashboardCustody.policyDailyValue", { value: maxDailyAmount }) : null,
    ].filter(Boolean);
    value = parts.length > 0 ? parts.join(" / ") : t("DashboardCustody.noCap");
  }
  if (category.id === "approvals") {
    value =
      approvalFamilies.length > 0
        ? t("DashboardCustody.policyRequireApprovalFor", { families: formatFamilyList(approvalFamilies, t) })
        : t("DashboardCustody.policyNoApprovalChecks");
  }
  if (category.id === "advanced") {
    value =
      advancedDeniedFamilies.length > 0
        ? t("DashboardCustody.policyDenyFamilies", { families: formatFamilyList(advancedDeniedFamilies, t) })
        : t("DashboardCustody.policyNoAdvancedControls");
  }

  return (
    <div className="border-t border-border-light p-4 first:border-t-0">
      <p className="text-sm font-semibold text-text-extra-high">{t(category.titleKey)}</p>
      <p className="mt-1 text-sm leading-6 text-text-medium">{value}</p>
    </div>
  );
}

function formatProviderMappingStatus(
  status: NonNullable<PaymentWalletPolicy["controlProfile"]>["providerMappingStatus"],
  t?: ReturnType<typeof useTranslations>
): string {
  const labels = {
    not_applicable: "DashboardCustody.policySdpEnforced",
    pending: "DashboardCustody.policyProviderMappingPending",
    synced: "DashboardCustody.policyProviderMapped",
    partial: "DashboardCustody.policyProviderPartiallyMapped",
    failed: "DashboardCustody.policyProviderMappingFailed",
  } satisfies Record<NonNullable<PaymentWalletPolicy["controlProfile"]>["providerMappingStatus"], MessageKey>;
  return t ? t(labels[status]) : labels[status];
}
