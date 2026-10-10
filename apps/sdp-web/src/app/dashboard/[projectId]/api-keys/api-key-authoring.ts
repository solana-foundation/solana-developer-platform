import {
  type AllowedOperation,
  type ApiKeyEnvironment,
  type ApiKeyRole,
  type ApiKeyWalletScope,
  isOperationFamily,
  normalizeAllowedOperations,
  OPERATION_FAMILIES,
  OPERATION_FAMILY_BY_TYPE,
  type OperationFamily,
  type OperationType,
  operationTypesInFamily,
  type Permission,
} from "@sdp/types";

export const API_KEY_AUTHORING_STEPS = ["details", "permissions", "wallets", "review"] as const;

export type ApiKeyAuthoringStep = (typeof API_KEY_AUTHORING_STEPS)[number];
export type ApiKeyAuthoringMode = "create" | "edit";

/** Whether a key may perform every operation, or only the ones ticked. */
export type OperationsScope = "all" | "selected";

export interface ApiKeyAuthoringDraft {
  name: string;
  role: ApiKeyRole;
  expiresAt: string;
  walletScope: ApiKeyWalletScope;
  selectedWalletIds: string[];
  defaultWalletId: string;
  operationsScope: OperationsScope;
  /** Ticked operations. A family entry covers every type in it. */
  selectedOperations: AllowedOperation[];
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
  /** Empty means the key is not restricted. */
  allowedOperations?: AllowedOperation[];
}

export function createApiKeyAuthoringDraft(): ApiKeyAuthoringDraft {
  return {
    name: "",
    role: "api_developer",
    expiresAt: "",
    walletScope: "all",
    selectedWalletIds: [],
    defaultWalletId: "",
    operationsScope: "all",
    selectedOperations: [],
  };
}

/** How much of a family is ticked: every type, some of them, or none. */
export type FamilyState = "all" | "some" | "none";

export function familyState(
  selected: readonly AllowedOperation[],
  family: OperationFamily
): FamilyState {
  if (selected.includes(family)) {
    return "all";
  }
  const types = operationTypesInFamily(family);
  const ticked = types.filter((type) => selected.includes(type));
  if (ticked.length === 0) {
    return "none";
  }
  return ticked.length === types.length ? "all" : "some";
}

export function isOperationTypeTicked(
  selected: readonly AllowedOperation[],
  type: OperationType
): boolean {
  return selected.includes(type) || selected.includes(OPERATION_FAMILY_BY_TYPE[type]);
}

function withoutFamily(
  selected: readonly AllowedOperation[],
  family: OperationFamily
): AllowedOperation[] {
  return selected.filter(
    (entry) =>
      entry !== family &&
      (isOperationFamily(entry) || OPERATION_FAMILY_BY_TYPE[entry as OperationType] !== family)
  );
}

/** Ticks a whole family, or clears it and every type under it. */
export function toggleFamily(
  selected: readonly AllowedOperation[],
  family: OperationFamily
): AllowedOperation[] {
  const cleared = withoutFamily(selected, family);
  return familyState(selected, family) === "none"
    ? normalizeAllowedOperations([...cleared, family])
    : normalizeAllowedOperations(cleared);
}

/**
 * Ticks or clears one type. A fully ticked family is stored as the family, and
 * unticking one of its types turns it into the remaining types.
 */
export function toggleOperationType(
  selected: readonly AllowedOperation[],
  type: OperationType
): AllowedOperation[] {
  const family = OPERATION_FAMILY_BY_TYPE[type];
  const familyTypes = operationTypesInFamily(family);
  const tickedTypes = new Set(familyTypes.filter((item) => isOperationTypeTicked(selected, item)));

  if (tickedTypes.has(type)) {
    tickedTypes.delete(type);
  } else {
    tickedTypes.add(type);
  }

  const rest = withoutFamily(selected, family);
  if (tickedTypes.size === familyTypes.length) {
    return normalizeAllowedOperations([...rest, family]);
  }
  return normalizeAllowedOperations([...rest, ...tickedTypes]);
}

/** The list sent to the API. Empty means the key is not restricted. */
export function buildAllowedOperations(draft: ApiKeyAuthoringDraft): AllowedOperation[] {
  if (draft.operationsScope === "all") {
    return [];
  }
  return normalizeAllowedOperations(draft.selectedOperations);
}

/** One line for the review step and the keys table. */
export function summarizeAllowedOperations(allowedOperations: readonly AllowedOperation[]): {
  kind: "unrestricted" | "families" | "mixed";
  families: OperationFamily[];
  typeCount: number;
} {
  if (allowedOperations.length === 0) {
    return { kind: "unrestricted", families: [], typeCount: 0 };
  }
  const families = OPERATION_FAMILIES.filter((family) => allowedOperations.includes(family));
  const typeCount = allowedOperations.filter((entry) => !isOperationFamily(entry)).length;
  return { kind: typeCount > 0 ? "mixed" : "families", families, typeCount };
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
