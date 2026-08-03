import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type PaymentWalletPolicy,
  type PolicyDefaultAction,
  type PolicyRule,
  type PolicyRuleAction,
  type SdpEnvironment,
  type WalletOperationFamily,
  WELL_KNOWN_TOKEN_BY_MINT,
  WELL_KNOWN_TOKENS,
  type WellKnownTokenCategory,
  type WellKnownTokenSymbol,
  wellKnownMint,
} from "@sdp/types";

export type PolicyFlowStep = "intent" | "limits-assets" | "destinations-operations" | "review";

export type RestrictionCategory = "limits" | "assets" | "destinations" | "operations";

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

export interface PolicyAssetOption {
  token: string;
  mint: string;
  /** Full token name, shown under the symbol when the catalogue knows it. */
  name?: string;
  category?: WellKnownTokenCategory;
  /** Only wallet holdings carry a balance; well-known mints are offered even when the wallet holds none. */
  uiAmount?: string;
  source: "wallet" | "well-known" | "issued";
}

/**
 * Wallet holdings first, then the tokens this project issued, then the well-known mints
 * for the active cluster that neither of the first two already covered. Without this the
 * picker only knows about tokens already in the wallet, so covering USDC on a fresh
 * wallet, or any token the org minted itself, meant pasting a mint address by hand.
 *
 * Holdings of a catalogued mint take their symbol/name from the well-known registry:
 * the balances API labels native SOL with its mint address, and holdings win the
 * per-mint dedupe, so without this the picker would show the raw address.
 */
export function buildPolicyAssetOptions(
  walletAssets: readonly { token: string; mint: string; uiAmount: string }[],
  environment: SdpEnvironment,
  issuedTokens: readonly { token: string; mint: string; name?: string }[] = []
): PolicyAssetOption[] {
  const options = new Map<string, PolicyAssetOption>();

  for (const asset of walletAssets) {
    if (options.has(asset.mint)) continue;
    const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(asset.mint);
    options.set(
      asset.mint,
      wellKnown
        ? {
            token: wellKnown.symbol,
            name: wellKnown.name,
            category: wellKnown.category,
            mint: asset.mint,
            uiAmount: asset.uiAmount,
            source: "wallet",
          }
        : { ...asset, source: "wallet" }
    );
  }

  // Issued tokens sit between holdings and the catalogue. A token the wallet already
  // holds keeps its holdings row so the balance stays visible, while an issued mint
  // still wins over a catalogue entry. This ordering also keeps the existing
  // "wallet holdings come first, well-known last" assertion true.
  //
  // Not filtered by `environment` on purpose: `issued_tokens` is scoped by project and
  // the dashboard derives its environment from the selected project, so the API has
  // already applied the cluster boundary.
  for (const issued of issuedTokens) {
    if (!issued.mint || options.has(issued.mint)) continue;
    options.set(issued.mint, {
      token: issued.token,
      ...(issued.name ? { name: issued.name } : {}),
      mint: issued.mint,
      source: "issued",
    });
  }

  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[environment];
  for (const symbol of Object.keys(WELL_KNOWN_TOKENS) as WellKnownTokenSymbol[]) {
    const token = WELL_KNOWN_TOKENS[symbol];
    const mint = wellKnownMint(symbol, cluster);
    // Tokens without a mint on this cluster (e.g. USDT on devnet) must not be offered.
    if (!mint || options.has(mint)) continue;
    options.set(mint, {
      token: token.symbol,
      name: token.name,
      category: token.category,
      mint,
      source: "well-known",
    });
  }

  return [...options.values()];
}

export interface PolicyAuthoringState {
  defaultAction: AuthoringDefaultAction;
  categories: RestrictionCategory[];
  maxTransferAmount: string;
  maxDailyAmount: string;
  assets: string[];
  destinationMode: DestinationMode;
  destinationAllowText: string;
  destinationBlockText: string;
  familyActions: Partial<Record<WalletOperationFamily, AuthoringRuleAction>>;
  operationTypeRules: OperationTypeRuleInput[];
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
  assets?: "invalid_asset";
  operations?: "invalid_operation_type";
  review?: "no_restrictions";
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
    case "approval":
      return "operations";
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

export function hasLimitsAndAssetsControls(
  state: Pick<PolicyAuthoringState, "categories">
): boolean {
  return state.categories.includes("limits") || state.categories.includes("assets");
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
  const allowDestinations: string[] = [];
  const blockDestinations: string[] = [];
  const familyActions: PolicyAuthoringState["familyActions"] = {};
  const operationTypeRules: OperationTypeRuleInput[] = [];
  const passthroughRules: PolicyRule[] = [];
  let hasEditableAllowRule = false;
  let hasEditableBlockRule = false;
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
          (ruleMode === "allowlist" ? hasEditableAllowRule : hasEditableBlockRule)
        ) {
          passthroughRules.push(rule);
        } else if (ruleMode === "allowlist") {
          hasEditableAllowRule = true;
          allowDestinations.push(...allowlist);
        } else {
          hasEditableBlockRule = true;
          blockDestinations.push(...blocklist);
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
          for (const family of rule.families ?? []) {
            if (isWalletOperationFamily(family)) familyActions[family] = "approval_required";
          }
        } else {
          passthroughRules.push(rule);
        }
        addCategory(categories, "operations");
        break;
      }
      default:
        passthroughRules.push(rule);
    }
  }

  if (policy.destinationAllowlist.length > 0 && allowDestinations.length === 0) {
    allowDestinations.push(...policy.destinationAllowlist);
  }
  if (allowDestinations.length > 0 || blockDestinations.length > 0) {
    addCategory(categories, "destinations");
  }
  if (policy.maxTransferAmount || policy.maxDailyAmount) addCategory(categories, "limits");

  return {
    defaultAction: normalizeAuthoringDefaultAction(
      policy.defaultAction ?? policy.controlProfile?.defaultAction
    ),
    categories,
    maxTransferAmount,
    maxDailyAmount: policy.maxDailyAmount ?? "",
    assets: uniqueValues(assets),
    destinationMode:
      blockDestinations.length > 0 && allowDestinations.length === 0 ? "blocklist" : "allowlist",
    destinationAllowText: uniqueValues(allowDestinations).join(", "),
    destinationBlockText: uniqueValues(blockDestinations).join(", "),
    familyActions,
    operationTypeRules: operationTypeRules.filter(
      (entry, index, values) => values.findIndex((item) => item.value === entry.value) === index
    ),
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
): PaymentWalletPolicy & { rules: PolicyRule[] } {
  const categories = new Set(state.categories);
  const allowDestinations = parseDestinationText(state.destinationAllowText).valid;
  const blockDestinations = parseDestinationText(state.destinationBlockText).valid;
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

  if (categories.has("destinations")) {
    if (allowDestinations.length > 0) {
      rules.push({
        id: "allowlist-destinations",
        kind: "destination",
        allowlist: allowDestinations,
        action: "allow",
        name: "Allowed destinations",
      });
    }
    if (blockDestinations.length > 0) {
      rules.push({
        id: "blocklist-destinations",
        kind: "destination",
        blocklist: blockDestinations,
        action: "deny",
        name: "Blocked destinations",
      });
    }
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

  return {
    walletId,
    destinationAllowlist: categories.has("destinations") ? allowDestinations : [],
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

  const payload = buildPolicyPayload("validation", state);
  if (
    payload.defaultAction === "allow" &&
    payload.rules.length === 0 &&
    !payload.maxTransferAmount &&
    !payload.maxDailyAmount
  ) {
    errors.review = "no_restrictions";
    if (state.categories.length === 0 && state.passthroughRules.length === 0) {
      errors.intent = "restriction_required";
    }
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

  if (categories.has("assets") && state.assets.some((asset) => !isValidSolanaAddress(asset))) {
    errors.assets = "invalid_asset";
  }

  if (
    categories.has("operations") &&
    state.operationTypeRules.some(
      (entry) => !entry.value.trim() || entry.value.trim().length > OPERATION_TYPE_MAX_LENGTH
    )
  ) {
    errors.operations = "invalid_operation_type";
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
    typeof state.destinationAllowText === "string" &&
    typeof state.destinationBlockText === "string" &&
    Boolean(state.familyActions) &&
    Array.isArray(state.operationTypeRules) &&
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
