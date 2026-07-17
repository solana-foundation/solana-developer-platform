import type {
  ApiKeyEnvironment,
  ApiKeyRole,
  ApiKeyWalletPolicyBindingSummary,
  ApiKeyWalletScope,
  Permission,
  PolicyDefaultAction,
  PolicyRule,
  WalletOperationFamily,
} from "@sdp/types";

export const API_KEY_AUTHORING_STEPS = ["details", "permissions", "wallets", "review"] as const;

export type ApiKeyAuthoringStep = (typeof API_KEY_AUTHORING_STEPS)[number];
export type ApiKeyAuthoringMode = "create" | "edit";
export type BindingConfirmation = "replace" | "clear";

export interface ApiKeyAuthoringDraft {
  name: string;
  role: ApiKeyRole;
  expiresAt: string;
  walletScope: ApiKeyWalletScope;
  selectedWalletIds: string[];
  defaultWalletId: string;
  restrictionsEnabled: boolean;
  restrictionsEdited: boolean;
  defaultAction: PolicyDefaultAction;
  operationFamilies: WalletOperationFamily[];
  operationTypes: string;
  assets: string;
  maximumAmount: string;
  destinations: string;
  approvalRequired: boolean;
}

export interface InitialApiKeyAuthoringState {
  walletScope: ApiKeyWalletScope;
  selectedWalletIds: string[];
  policyBindings: ApiKeyWalletPolicyBindingSummary[];
}

export interface ApiKeyAuthoringExistingKey {
  id: string;
  name: string;
  role: ApiKeyRole;
  environment: ApiKeyEnvironment;
  permissions: Permission[] | null;
  expiresAt: string | null;
  walletScope: ApiKeyWalletScope;
  signingWalletId: string | null;
  signingWalletIds: string[];
  policyBindings: ApiKeyWalletPolicyBindingSummary[];
}

export interface PolicyBindingTarget {
  bindingScope: ApiKeyWalletScope;
  walletId?: string;
  apiKeyControlProfileId: string;
}

export type PolicyBindingIntent =
  | { mode: "none" }
  | { mode: "blocked"; reason: "replace_restrictions_required" }
  | {
      mode: "replace";
      profile: "new" | "existing";
      existingProfileId?: string;
      confirmationRequired: boolean;
      affectedTargets: string[];
    }
  | {
      mode: "clear";
      confirmationRequired: boolean;
      affectedTargets: string[];
    };

export function createApiKeyAuthoringDraft(): ApiKeyAuthoringDraft {
  return {
    name: "",
    role: "api_developer",
    expiresAt: "",
    walletScope: "all",
    selectedWalletIds: [],
    defaultWalletId: "",
    restrictionsEnabled: false,
    restrictionsEdited: false,
    defaultAction: "allow",
    operationFamilies: [],
    operationTypes: "",
    assets: "",
    maximumAmount: "",
    destinations: "",
    approvalRequired: false,
  };
}

export function splitPolicyValues(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,;\t]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

export function buildApiKeyPolicyRules(draft: ApiKeyAuthoringDraft): PolicyRule[] {
  if (!draft.restrictionsEnabled || !draft.restrictionsEdited) {
    return [];
  }

  const rules: PolicyRule[] = [];
  if (draft.operationFamilies.length > 0) {
    rules.push({
      id: "additional-operation-families",
      name: "Additional restriction: operation families",
      kind: "operation_family",
      families: draft.operationFamilies,
      action: "deny",
    });
  }

  const operationTypes = splitPolicyValues(draft.operationTypes);
  if (operationTypes.length > 0) {
    rules.push({
      id: "additional-operation-types",
      name: "Additional restriction: operation types",
      kind: "operation_type",
      operationTypes,
      action: "deny",
    });
  }

  const assets = splitPolicyValues(draft.assets);
  if (assets.length > 0) {
    rules.push({
      id: "additional-assets",
      name: "Additional restriction: assets",
      kind: "asset",
      assets,
      action: "deny",
    });
  }

  const maximumAmount = draft.maximumAmount.trim();
  if (maximumAmount) {
    rules.push({
      id: "additional-amount-constraint",
      name: "Additional restriction: amount constraints",
      kind: "amount",
      max: maximumAmount,
      action: "allow",
    });
  }

  const destinations = splitPolicyValues(draft.destinations);
  if (destinations.length > 0) {
    rules.push({
      id: "additional-destinations",
      name: "Additional restriction: destinations",
      kind: "destination",
      allowlist: destinations,
      action: "allow",
    });
  }

  if (draft.approvalRequired) {
    rules.push({
      id: "additional-approval-requirement",
      name: "Additional restriction: approval requirements",
      kind: "approval",
      action: "approval_required",
    });
  }

  return rules;
}

export function buildEndpointWalletPayload(draft: ApiKeyAuthoringDraft): {
  walletScope: ApiKeyWalletScope;
  signingWalletId?: string;
  signingWalletIds?: string[];
} {
  if (draft.walletScope === "all") {
    return { walletScope: "all" };
  }

  const selectedWalletIds = Array.from(new Set(draft.selectedWalletIds));
  const signingWalletId = selectedWalletIds.includes(draft.defaultWalletId)
    ? draft.defaultWalletId
    : selectedWalletIds[0];

  return {
    walletScope: "selected",
    signingWalletId,
    signingWalletIds: selectedWalletIds,
  };
}

export function buildPolicyBindingTargets(
  draft: ApiKeyAuthoringDraft,
  apiKeyControlProfileId: string
): PolicyBindingTarget[] {
  if (draft.walletScope === "all") {
    return [{ bindingScope: "all", apiKeyControlProfileId }];
  }

  return Array.from(new Set(draft.selectedWalletIds)).map((walletId) => ({
    bindingScope: "selected",
    walletId,
    apiKeyControlProfileId,
  }));
}

function endpointScopeChanged(
  initial: InitialApiKeyAuthoringState,
  draft: ApiKeyAuthoringDraft
): boolean {
  if (initial.walletScope !== draft.walletScope) {
    return true;
  }
  if (draft.walletScope === "all") {
    return false;
  }

  const current = [...new Set(initial.selectedWalletIds)].sort();
  const proposed = [...new Set(draft.selectedWalletIds)].sort();
  return (
    current.length !== proposed.length || current.some((value, index) => value !== proposed[index])
  );
}

function bindingTargets(bindings: ApiKeyWalletPolicyBindingSummary[]): string[] {
  return bindings.map((binding) =>
    binding.bindingScope === "all" ? "all" : (binding.walletId ?? "selected")
  );
}

export function getPolicyBindingIntent(
  mode: ApiKeyAuthoringMode,
  initial: InitialApiKeyAuthoringState | null,
  draft: ApiKeyAuthoringDraft
): PolicyBindingIntent {
  if (mode === "create" || !initial) {
    return draft.restrictionsEnabled
      ? {
          mode: "replace",
          profile: "new",
          confirmationRequired: false,
          affectedTargets: [],
        }
      : { mode: "none" };
  }

  const currentBindings = initial.policyBindings;
  const affectedTargets = bindingTargets(currentBindings);
  const scopeChanged = endpointScopeChanged(initial, draft);
  const apiProfileIds = Array.from(
    new Set(
      currentBindings
        .map((binding) => binding.apiKeyControlProfileId)
        .filter((profileId): profileId is string => Boolean(profileId))
    )
  );
  const hadApiRestrictions = apiProfileIds.length > 0;

  if (!draft.restrictionsEnabled) {
    if (hadApiRestrictions || (scopeChanged && currentBindings.length > 0)) {
      return {
        mode: "clear",
        confirmationRequired: currentBindings.length > 0,
        affectedTargets,
      };
    }
    return { mode: "none" };
  }

  if (draft.restrictionsEdited || !hadApiRestrictions) {
    return {
      mode: "replace",
      profile: apiProfileIds.length === 1 ? "existing" : "new",
      existingProfileId: apiProfileIds.length === 1 ? apiProfileIds[0] : undefined,
      confirmationRequired: currentBindings.length > 0,
      affectedTargets,
    };
  }

  if (!scopeChanged) {
    return { mode: "none" };
  }

  if (apiProfileIds.length !== 1) {
    return { mode: "blocked", reason: "replace_restrictions_required" };
  }

  return {
    mode: "replace",
    profile: "existing",
    existingProfileId: apiProfileIds[0],
    confirmationRequired: currentBindings.length > 0,
    affectedTargets,
  };
}

export function requiredBindingConfirmation(
  intent: PolicyBindingIntent
): BindingConfirmation | null {
  if (intent.mode === "clear" && intent.confirmationRequired) {
    return "clear";
  }
  if (intent.mode === "replace" && intent.confirmationRequired) {
    return "replace";
  }
  return null;
}

export function isPositiveDecimal(value: string): boolean {
  const normalized = value.trim();
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) && /[1-9]/.test(normalized);
}
