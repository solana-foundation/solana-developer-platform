import type {
  PaymentWalletPolicy,
  PolicyDefaultAction,
  PolicyProviderSyncStatus,
  PolicyRule,
  PolicyRuleAction,
  WalletOperationFamily,
} from "@sdp/types";

export type PolicyFlowStep = "intent" | "limits-assets" | "destinations-operations" | "review";

export type RestrictionCategory = "limits" | "assets" | "destinations" | "operations" | "approvals";

export type AuthoringRuleAction = Exclude<
  PolicyRuleAction,
  "provider_approval_required" | "review"
>;
export type AuthoringDefaultAction = Exclude<PolicyDefaultAction, "review">;
export type DestinationMode = "allowlist" | "blocklist";

export interface OperationTypeRuleInput {
  value: string;
  action: AuthoringRuleAction;
}

export interface PolicyAuthoringState {
  defaultAction: AuthoringDefaultAction;
  categories: RestrictionCategory[];
  maxTransferAmount: string;
  maxDailyAmount: string;
  assets: string[];
  destinationMode: DestinationMode;
  destinationText: string;
  familyActions: Partial<Record<WalletOperationFamily, AuthoringRuleAction>>;
  operationTypeRules: OperationTypeRuleInput[];
  approvalFamilies: WalletOperationFamily[];
  passthroughRules: PolicyRule[];
}

export interface StoredPolicyDraft {
  version: 1;
  projectId: string;
  walletId: string;
  step: PolicyFlowStep;
  state: PolicyAuthoringState;
  updatedAt: string;
}

export interface PolicyValidationErrors {
  intent?: "restriction_required";
  maxTransferAmount?: "invalid_decimal";
  maxDailyAmount?: "invalid_decimal" | "daily_below_transaction";
  assets?: "asset_required" | "invalid_asset";
  destinations?: "destination_required" | "invalid_destination";
  operations?: "operation_required" | "invalid_operation_type";
  approvals?: "approval_required";
}

export interface ParsedDestinationEntry {
  position: number;
  value: string;
  valid: boolean;
  duplicate: boolean;
}

export interface ParsedDestinations {
  entries: ParsedDestinationEntry[];
  valid: string[];
  invalid: ParsedDestinationEntry[];
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const WALLET_OPERATION_FAMILIES = [
  "transfer",
  "payment",
  "ramp",
  "issuance",
  "raw_sign",
  "program",
  "provider_admin",
] as const satisfies readonly WalletOperationFamily[];

export const SUPPORTED_WALLET_OPERATION_TYPES = [
  { value: "payment_transfer_execute", family: "payment" },
  { value: "payment_transfer_batch_execute", family: "payment" },
  { value: "ramp_onramp_quote", family: "ramp" },
  { value: "ramp_offramp_quote", family: "ramp" },
  { value: "issuance_mint_execute", family: "issuance" },
  { value: "issuance_update_authority_execute", family: "issuance" },
  { value: "custody_signer_check", family: "raw_sign" },
] as const satisfies readonly { value: string; family: WalletOperationFamily }[];

export const AUTHORING_RULE_ACTIONS = [
  "allow",
  "deny",
  "approval_required",
] as const satisfies readonly AuthoringRuleAction[];

export const POLICY_DEFAULT_ACTIONS = [
  "allow",
  "approval_required",
  "deny",
] as const satisfies readonly AuthoringDefaultAction[];

export const DESTINATION_MODES = [
  "allowlist",
  "blocklist",
] as const satisfies readonly DestinationMode[];

const POLICY_FLOW_STEPS = [
  "intent",
  "limits-assets",
  "destinations-operations",
  "review",
] as const satisfies readonly PolicyFlowStep[];

const RESTRICTION_CATEGORIES = [
  "limits",
  "assets",
  "destinations",
  "operations",
  "approvals",
] as const satisfies readonly RestrictionCategory[];

const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const OPERATION_TYPE_MAX_LENGTH = 120;

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isAuthoringRuleAction(value: unknown): value is AuthoringRuleAction {
  return AUTHORING_RULE_ACTIONS.includes(value as AuthoringRuleAction);
}

function normalizeAuthoringRuleAction(
  action: PolicyRuleAction | undefined
): AuthoringRuleAction | null {
  const normalized = action === "review" ? "approval_required" : (action ?? "allow");
  return isAuthoringRuleAction(normalized) ? normalized : null;
}

function normalizeAuthoringDefaultAction(
  action: PolicyDefaultAction | undefined
): AuthoringDefaultAction {
  return action === "review" ? "approval_required" : (action ?? "allow");
}

function isWalletOperationFamily(value: unknown): value is WalletOperationFamily {
  return WALLET_OPERATION_FAMILIES.includes(value as WalletOperationFamily);
}

function operationFamiliesFromRule(
  rule: Extract<PolicyRule, { kind: "operation_family" }>
): WalletOperationFamily[] {
  return uniqueValues(rule.families ?? (rule.family ? [rule.family] : [])).filter(
    isWalletOperationFamily
  );
}

function operationTypesFromRule(rule: Extract<PolicyRule, { kind: "operation_type" }>): string[] {
  return uniqueValues(rule.operationTypes ?? (rule.operationType ? [rule.operationType] : []));
}

function assetsFromRule(rule: Extract<PolicyRule, { kind: "asset" }>): string[] {
  return uniqueValues(rule.assets ?? (rule.asset ? [rule.asset] : []));
}

function categoryForRule(rule: PolicyRule): RestrictionCategory | null {
  switch (rule.kind) {
    case "amount":
      return "limits";
    case "asset":
      return "assets";
    case "destination":
      return "destinations";
    case "operation_family":
    case "operation_type":
      return "operations";
    case "approval":
      return "approvals";
    default:
      return null;
  }
}

function addCategory(categories: RestrictionCategory[], category: RestrictionCategory) {
  if (!categories.includes(category)) categories.push(category);
}

export function isValidSolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS_PATTERN.test(value.trim());
}

export function isValidDecimal(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || (DECIMAL_PATTERN.test(trimmed) && /[1-9]/.test(trimmed));
}

function compareDecimals(left: string, right: string): number {
  const [leftWhole, leftFraction = ""] = left.split(".");
  const [rightWhole, rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const multiplier = 10n ** BigInt(scale);
  const leftFractionValue = leftFraction.padEnd(scale, "0").replace(/^0+/, "") || "0";
  const rightFractionValue = rightFraction.padEnd(scale, "0").replace(/^0+/, "") || "0";
  const leftValue = BigInt(leftWhole) * multiplier + BigInt(leftFractionValue);
  const rightValue = BigInt(rightWhole) * multiplier + BigInt(rightFractionValue);
  return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
}

export function parseDestinationText(value: string): ParsedDestinations {
  const seen = new Set<string>();
  const entries = value
    .split(/[,\r\n]+/)
    .map((rawValue, index): ParsedDestinationEntry | null => {
      const entry = rawValue.trim();
      if (!entry) return null;
      const duplicate = seen.has(entry);
      seen.add(entry);
      return {
        position: index + 1,
        value: entry,
        valid: isValidSolanaAddress(entry),
        duplicate,
      };
    })
    .filter((entry): entry is ParsedDestinationEntry => entry !== null);

  return {
    entries,
    valid: entries.filter((entry) => entry.valid && !entry.duplicate).map((entry) => entry.value),
    invalid: entries.filter((entry) => !entry.valid),
  };
}

// Each rule kind has a distinct public shape; keeping the conversion in one pass preserves order.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the branches mirror the PolicyRule union.
export function createPolicyAuthoringState(policy: PaymentWalletPolicy): PolicyAuthoringState {
  const rules = policy.rules ?? policy.controlProfile?.rules ?? [];
  const categories: RestrictionCategory[] = [];
  const assets: string[] = [];
  const destinations: string[] = [];
  const familyActions: PolicyAuthoringState["familyActions"] = {};
  const operationTypeRules: OperationTypeRuleInput[] = [];
  const approvalFamilies: WalletOperationFamily[] = [];
  const passthroughRules: PolicyRule[] = [];
  let destinationMode: DestinationMode = "allowlist";
  let editableDestinationMode: DestinationMode | null = null;
  let maxTransferAmount = policy.maxTransferAmount ?? "";

  for (const rule of rules) {
    switch (rule.kind) {
      case "operation_family": {
        const families = operationFamiliesFromRule(rule);
        const action = normalizeAuthoringRuleAction(rule.action);
        if (families.length === 0 || !action) {
          passthroughRules.push(rule);
          addCategory(categories, "operations");
          break;
        }
        for (const family of families) familyActions[family] = action;
        addCategory(categories, "operations");
        break;
      }
      case "operation_type": {
        const values = operationTypesFromRule(rule);
        const action = normalizeAuthoringRuleAction(rule.action);
        if (values.length === 0 || !action) {
          passthroughRules.push(rule);
          addCategory(categories, "operations");
          break;
        }
        for (const value of values) operationTypeRules.push({ value, action });
        addCategory(categories, "operations");
        break;
      }
      case "asset": {
        const values = assetsFromRule(rule);
        if (values.length === 0 || (rule.action && rule.action !== "allow")) {
          passthroughRules.push(rule);
        } else {
          assets.push(...values);
        }
        addCategory(categories, "assets");
        break;
      }
      case "destination": {
        const allowlist = uniqueValues([
          ...(rule.allowlist ?? []),
          ...(rule.destinations ?? []),
          ...(rule.destination ? [rule.destination] : []),
        ]);
        const blocklist = uniqueValues(rule.blocklist ?? []);
        const ruleMode =
          allowlist.length > 0 && blocklist.length === 0
            ? "allowlist"
            : blocklist.length > 0 && allowlist.length === 0
              ? "blocklist"
              : null;
        const hasEditableAction =
          !rule.action ||
          (ruleMode === "allowlist" && rule.action === "allow") ||
          (ruleMode === "blocklist" && rule.action === "deny");

        if (
          !ruleMode ||
          !hasEditableAction ||
          (editableDestinationMode !== null && editableDestinationMode !== ruleMode)
        ) {
          passthroughRules.push(rule);
        } else {
          editableDestinationMode = ruleMode;
          destinationMode = ruleMode;
          destinations.push(...(ruleMode === "allowlist" ? allowlist : blocklist));
        }
        addCategory(categories, "destinations");
        break;
      }
      case "amount": {
        const isGenericMaximum =
          Boolean(rule.max) &&
          !rule.min &&
          !rule.asset &&
          !rule.assets?.length &&
          (!rule.action || rule.action === "allow");
        if (isGenericMaximum && !maxTransferAmount) {
          maxTransferAmount = rule.max ?? "";
        } else if (!isGenericMaximum || (rule.max && rule.max !== maxTransferAmount)) {
          passthroughRules.push(rule);
        }
        addCategory(categories, "limits");
        break;
      }
      case "approval": {
        const isFamilyOnly =
          Boolean(rule.families?.length) &&
          !rule.operationTypes?.length &&
          !rule.assets?.length &&
          !rule.approvalGroupId &&
          (!rule.action || rule.action === "approval_required");
        if (isFamilyOnly) {
          approvalFamilies.push(...(rule.families ?? []).filter(isWalletOperationFamily));
        } else {
          passthroughRules.push(rule);
        }
        addCategory(categories, "approvals");
        break;
      }
      default:
        passthroughRules.push(rule);
    }
  }

  if (policy.destinationAllowlist.length > 0 && destinations.length === 0) {
    destinations.push(...policy.destinationAllowlist);
    destinationMode = "allowlist";
  }
  if (destinations.length > 0) addCategory(categories, "destinations");
  if (policy.maxTransferAmount || policy.maxDailyAmount) addCategory(categories, "limits");

  return {
    defaultAction: normalizeAuthoringDefaultAction(
      policy.defaultAction ?? policy.controlProfile?.defaultAction
    ),
    categories,
    maxTransferAmount,
    maxDailyAmount: policy.maxDailyAmount ?? "",
    assets: uniqueValues(assets),
    destinationMode,
    destinationText: uniqueValues(destinations).join(", "),
    familyActions,
    operationTypeRules: operationTypeRules.filter(
      (entry, index, values) => values.findIndex((item) => item.value === entry.value) === index
    ),
    approvalFamilies: uniqueValues(approvalFamilies).filter(isWalletOperationFamily),
    passthroughRules,
  };
}

function groupedValuesByAction<TValue extends string>(
  entries: readonly { value: TValue; action: AuthoringRuleAction }[]
): Map<AuthoringRuleAction, TValue[]> {
  const grouped = new Map<AuthoringRuleAction, TValue[]>();
  for (const entry of entries) {
    grouped.set(entry.action, [...(grouped.get(entry.action) ?? []), entry.value]);
  }
  return grouped;
}

export function buildPolicyPayload(
  walletId: string,
  state: PolicyAuthoringState
): PaymentWalletPolicy {
  const categories = new Set(state.categories);
  const destinations = parseDestinationText(state.destinationText).valid;
  const rules = state.passthroughRules.filter((rule) => {
    const category = categoryForRule(rule);
    return category === null || categories.has(category);
  });

  if (categories.has("operations")) {
    const familyEntries = WALLET_OPERATION_FAMILIES.flatMap((family) => {
      const action = state.familyActions[family];
      return action ? [{ value: family, action }] : [];
    });
    for (const [action, families] of groupedValuesByAction(familyEntries)) {
      rules.push({
        id: `operation-families-${action}`,
        kind: "operation_family",
        families,
        action,
        name: `Operation families: ${action.replaceAll("_", " ")}`,
      });
    }

    for (const [action, operationTypes] of groupedValuesByAction(state.operationTypeRules)) {
      rules.push({
        id: `operation-types-${action}`,
        kind: "operation_type",
        operationTypes,
        action,
        name: `Operation types: ${action.replaceAll("_", " ")}`,
      });
    }
  }

  if (categories.has("assets") && state.assets.length > 0) {
    rules.push({
      id: "allowed-assets",
      kind: "asset",
      assets: uniqueValues(state.assets),
      action: "allow",
      name: "Allowed assets",
    });
  }

  if (categories.has("destinations") && destinations.length > 0) {
    rules.push({
      id: `${state.destinationMode}-destinations`,
      kind: "destination",
      ...(state.destinationMode === "allowlist"
        ? { allowlist: destinations, action: "allow" as const }
        : { blocklist: destinations, action: "deny" as const }),
      name: state.destinationMode === "allowlist" ? "Allowed destinations" : "Blocked destinations",
    });
  }

  const maxTransferAmount = state.maxTransferAmount.trim();
  const maxDailyAmount = state.maxDailyAmount.trim();
  if (categories.has("limits") && maxTransferAmount) {
    rules.push({
      id: "per-transaction-limit",
      kind: "amount",
      max: maxTransferAmount,
      action: "allow",
      name: "Per transaction limit",
    });
  }

  if (categories.has("approvals") && state.approvalFamilies.length > 0) {
    rules.push({
      id: "approval-checks",
      kind: "approval",
      families: state.approvalFamilies,
      action: "approval_required",
      name: "Approval checks",
    });
  }

  return {
    walletId,
    destinationAllowlist:
      categories.has("destinations") && state.destinationMode === "allowlist" ? destinations : [],
    ...(categories.has("limits") && maxTransferAmount ? { maxTransferAmount } : {}),
    ...(categories.has("limits") && maxDailyAmount ? { maxDailyAmount } : {}),
    defaultAction: state.defaultAction,
    rules,
  };
}

export function buildDisabledPolicyPayload(walletId: string): PaymentWalletPolicy {
  return {
    walletId,
    destinationAllowlist: [],
    defaultAction: "allow",
    rules: [],
  };
}

export function validatePolicyState(state: PolicyAuthoringState): PolicyValidationErrors {
  const errors: PolicyValidationErrors = {};
  const categories = new Set(state.categories);
  const hasPreservedRule = (category: RestrictionCategory) =>
    state.passthroughRules.some((rule) => categoryForRule(rule) === category);

  if (
    state.defaultAction === "allow" &&
    state.categories.length === 0 &&
    state.passthroughRules.length === 0
  ) {
    errors.intent = "restriction_required";
  }

  if (!isValidDecimal(state.maxTransferAmount)) errors.maxTransferAmount = "invalid_decimal";
  if (!isValidDecimal(state.maxDailyAmount)) errors.maxDailyAmount = "invalid_decimal";
  if (
    !errors.maxTransferAmount &&
    !errors.maxDailyAmount &&
    state.maxTransferAmount.trim() &&
    state.maxDailyAmount.trim() &&
    compareDecimals(state.maxDailyAmount.trim(), state.maxTransferAmount.trim()) < 0
  ) {
    errors.maxDailyAmount = "daily_below_transaction";
  }

  if (
    categories.has("limits") &&
    !state.maxTransferAmount.trim() &&
    !state.maxDailyAmount.trim() &&
    !hasPreservedRule("limits")
  ) {
    errors.maxTransferAmount = "invalid_decimal";
  }

  if (categories.has("assets")) {
    if (state.assets.length === 0 && !hasPreservedRule("assets")) errors.assets = "asset_required";
    else if (state.assets.some((asset) => !isValidSolanaAddress(asset)))
      errors.assets = "invalid_asset";
  }

  if (categories.has("destinations")) {
    const parsed = parseDestinationText(state.destinationText);
    if (parsed.valid.length === 0 && !hasPreservedRule("destinations")) {
      errors.destinations = "destination_required";
    } else if (parsed.invalid.length > 0) errors.destinations = "invalid_destination";
  }

  if (categories.has("operations")) {
    const hasFamily = Object.values(state.familyActions).some(Boolean);
    if (!hasFamily && state.operationTypeRules.length === 0 && !hasPreservedRule("operations")) {
      errors.operations = "operation_required";
    } else if (
      state.operationTypeRules.some(
        (entry) => !entry.value.trim() || entry.value.trim().length > OPERATION_TYPE_MAX_LENGTH
      )
    ) {
      errors.operations = "invalid_operation_type";
    }
  }

  if (
    categories.has("approvals") &&
    state.approvalFamilies.length === 0 &&
    !hasPreservedRule("approvals")
  ) {
    errors.approvals = "approval_required";
  }

  return errors;
}

export function policyDraftStorageKey(projectId: string, walletId: string): string {
  return `sdp.wallet-policy-authoring.v1.${projectId}.${walletId}`;
}

function hasOnlyKnownValues<TValue extends string>(
  values: unknown,
  allowed: readonly TValue[]
): values is TValue[] {
  return Array.isArray(values) && values.every((value) => allowed.includes(value as TValue));
}

function isStoredPolicyDraft(
  value: unknown,
  projectId: string,
  walletId: string
): value is StoredPolicyDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<StoredPolicyDraft>;
  const state = draft.state as Partial<PolicyAuthoringState> | undefined;
  return (
    draft.version === 1 &&
    draft.projectId === projectId &&
    draft.walletId === walletId &&
    hasOnlyKnownValues([draft.step], POLICY_FLOW_STEPS) &&
    typeof draft.updatedAt === "string" &&
    Boolean(state) &&
    hasOnlyKnownValues([state?.defaultAction], POLICY_DEFAULT_ACTIONS) &&
    hasOnlyKnownValues(state?.categories, RESTRICTION_CATEGORIES) &&
    typeof state?.maxTransferAmount === "string" &&
    typeof state.maxDailyAmount === "string" &&
    Array.isArray(state.assets) &&
    state.assets.every((asset) => typeof asset === "string") &&
    (state.destinationMode === "allowlist" || state.destinationMode === "blocklist") &&
    typeof state.destinationText === "string" &&
    Boolean(state.familyActions) &&
    Array.isArray(state.operationTypeRules) &&
    Array.isArray(state.approvalFamilies) &&
    Array.isArray(state.passthroughRules)
  );
}

export function savePolicyDraft(storage: StorageLike, draft: StoredPolicyDraft): void {
  storage.setItem(policyDraftStorageKey(draft.projectId, draft.walletId), JSON.stringify(draft));
}

export function loadPolicyDraft(
  storage: StorageLike,
  projectId: string,
  walletId: string
): StoredPolicyDraft | null {
  const key = policyDraftStorageKey(projectId, walletId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredPolicyDraft(parsed, projectId, walletId)) {
      storage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function clearPolicyDraft(storage: StorageLike, projectId: string, walletId: string): void {
  storage.removeItem(policyDraftStorageKey(projectId, walletId));
}

export function policyStateFingerprint(walletId: string, state: PolicyAuthoringState): string {
  return JSON.stringify(buildPolicyPayload(walletId, state));
}

export function countConfiguredRules(state: PolicyAuthoringState): number {
  const payload = buildPolicyPayload("summary", state);
  return payload.rules?.length ?? 0;
}

export function formatProviderMappingLabel(
  status: PolicyProviderSyncStatus | null,
  hasProvider: boolean
):
  | "SDP-enforced"
  | "Provider sync pending"
  | "Provider synced"
  | "Provider partially mapped"
  | "Provider mapping failed"
  | "Not applicable" {
  if (!hasProvider) return "Not applicable";
  switch (status) {
    case "pending":
      return "Provider sync pending";
    case "synced":
      return "Provider synced";
    case "partial":
      return "Provider partially mapped";
    case "failed":
      return "Provider mapping failed";
    default:
      return "SDP-enforced";
  }
}

export function isProviderMappingWarning(status: PolicyProviderSyncStatus | null): boolean {
  return status === "partial" || status === "failed";
}
