import { type AssetCategory, getAssetTypeRegistryEntry, type IssuanceMetadata } from "@sdp/types";
import { CAPACITY_KEYS, type DraftState, isValidDecimals } from "./issuance-draft-wizard.types";

const SYMBOL_RE = /^[A-Za-z0-9.]{1,10}$/;

// Asset category -> deploy-time Token-2022 template (token creation still needs
// a template; asset type describes the product, not the token config).
export function categoryToTemplate(category: AssetCategory | null): string {
  switch (category) {
    case "stablecoin":
      return "stablecoin";
    case "tokenized_security":
      return "tokenized-security";
    default:
      return "custom";
  }
}

export interface TokenInput {
  name: string;
  symbol: string;
  decimals: string;
  template: string;
  requiresAllowlist: boolean;
  description?: string;
  uri?: string;
  imageUrl?: string;
  signingWalletId?: string;
}

// Input/result for the create-asset-draft server action. Kept here (not in the
// "use server" module, which may only export async functions).
export interface CreateAssetDraftInput {
  token: TokenInput;
  assetCategory: AssetCategory;
  assetType: string;
  issuanceMetadata: IssuanceMetadata;
  // Set when retrying after the token was created but the profile POST failed —
  // skips token creation so we never make a duplicate token.
  existingTokenId?: string;
}

export interface CreateAssetDraftResult {
  state: "success" | "error";
  message: string;
  tokenId: string | null;
}

export function buildTokenInput(draft: DraftState): TokenInput {
  return {
    name: draft.name.trim(),
    symbol: draft.symbol.trim(),
    decimals: draft.decimals.trim(),
    template: categoryToTemplate(draft.assetCategory),
    requiresAllowlist: draft.accessControl === "allowlist",
    description: draft.description.trim() || undefined,
    uri: draft.metadataUri.trim() || undefined,
    imageUrl: draft.imageUrl.trim() || undefined,
    signingWalletId: draft.signingWalletId.trim() || undefined,
  };
}

function pruneEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

// Assemble the namespaced canonical issuance metadata from the flat draft.
// compliance.* and custom.* stay private; only registry-projected fields ever
// surface publicly.
export function buildIssuanceMetadata(draft: DraftState): IssuanceMetadata {
  const asset = pruneEmpty({
    name: draft.name.trim(),
    description: draft.description.trim(),
    website: draft.website.trim(),
    issuerName: draft.issuerName.trim(),
    backingType: draft.backingType,
    pegCurrency: draft.pegCurrency,
    pegTarget: draft.pegTarget.trim(),
    reserveAsset: draft.reserveAsset.trim(),
    reserveCustodian: draft.reserveCustodian.trim(),
    redemptionEnabled: draft.redemptionEnabled ? true : undefined,
    jurisdiction: draft.jurisdiction,
    offeringType: draft.offeringType,
    underlyingAsset: draft.underlyingAsset.trim(),
    custodian: draft.custodian.trim(),
    documents: draft.documents
      .filter((doc) => doc.name.trim() || doc.url.trim())
      .map((doc) => ({ type: doc.docType.trim(), name: doc.name.trim(), url: doc.url.trim() })),
  });

  const capacities = pruneEmpty(
    Object.fromEntries(CAPACITY_KEYS.map((key) => [key, draft.capacities[key] ? true : undefined]))
  );
  const compliance = pruneEmpty({
    accessControl: draft.accessControl || undefined,
    capacities: Object.keys(capacities).length > 0 ? capacities : undefined,
  });

  const decimals = draft.decimals.trim();
  const chain = pruneEmpty({
    decimals: isValidDecimals(decimals) ? Number(decimals) : undefined,
  });

  const customer = pruneEmpty(
    Object.fromEntries(
      draft.customFields
        .filter((field) => field.key.trim())
        .map((field) => [field.key.trim(), field.value])
    )
  );
  const custom = pruneEmpty({ customer: Object.keys(customer).length > 0 ? customer : undefined });

  return pruneEmpty({ asset, compliance, chain, custom }) as IssuanceMetadata;
}

export function getByPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

export interface ProjectionField {
  path: string;
  label: string;
  value: unknown;
  present: boolean;
}

const PATH_LABELS: Record<string, string> = {
  "asset.name": "Name",
  "asset.description": "Description",
  "asset.issuerName": "Issuer name",
  "asset.pegCurrency": "Peg currency",
  "asset.website": "Website",
  "chain.decimals": "Decimals",
};

export function pathLabel(path: string): string {
  if (PATH_LABELS[path]) {
    return PATH_LABELS[path];
  }
  const last = path.split(".").pop() ?? path;
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

// Registry-driven public projection for the selected (category, type), resolved
// against the assembled metadata (Step 3 preview).
export function getPublicProjection(draft: DraftState): ProjectionField[] {
  if (!draft.assetCategory || !draft.assetType) {
    return [];
  }
  const entry = getAssetTypeRegistryEntry(draft.assetCategory, draft.assetType);
  if (!entry) {
    return [];
  }
  const metadata = buildIssuanceMetadata(draft);
  return entry.publicProjection.map((path) => {
    const value = getByPath(metadata, path);
    return { path, label: pathLabel(path), value, present: value !== undefined };
  });
}

export function isValidUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Deploy-required metadata dot-paths mapped back to the flat draft field they
// come from, so a missing deploy field can be flagged on its own input.
const DEPLOY_PATH_TO_FIELD: Partial<Record<string, keyof DraftState>> = {
  "asset.issuerName": "issuerName",
  "asset.pegCurrency": "pegCurrency",
  "chain.decimals": "decimals",
};

// The Asset-details fields that must be filled: the on-screen "About this asset"
// block plus the selected type's deploy-required fields (issuer name, currency,
// …). Returned as a set of draft keys so the form can mark them required.
export function getRequiredAssetDetailKeys(draft: DraftState): Set<keyof DraftState> {
  const keys = new Set<keyof DraftState>(["symbol", "decimals", "description"]);
  if (draft.assetCategory && draft.assetType) {
    const entry = getAssetTypeRegistryEntry(draft.assetCategory, draft.assetType);
    for (const path of entry?.requiredForDeploy ?? []) {
      const field = DEPLOY_PATH_TO_FIELD[path];
      if (field) {
        keys.add(field);
      }
    }
  }
  return keys;
}

// Per-field validation for the required Asset-details fields — empty or badly
// formatted entries map to a user-facing message, keyed by draft field. Drives
// the form's inline errors, the Continue gate, and the review blockers.
export function getAssetDetailsErrors(
  draft: DraftState
): Partial<Record<keyof DraftState, string>> {
  const errors: Partial<Record<keyof DraftState, string>> = {};

  const symbol = draft.symbol.trim();
  if (!symbol) {
    errors.symbol = "Symbol is required.";
  } else if (!SYMBOL_RE.test(symbol)) {
    errors.symbol = "Use 1–10 letters, numbers, or periods.";
  }

  if (!isValidDecimals(draft.decimals)) {
    errors.decimals = "Enter a whole number between 0 and 18.";
  }

  if (!draft.description.trim()) {
    errors.description = "Description is required.";
  }

  // Website and logo are optional, but must be valid URLs when provided.
  if (draft.website.trim() && !isValidUrl(draft.website)) {
    errors.website = "Enter a valid URL (https://…).";
  }

  if (draft.imageUrl.trim() && !isValidUrl(draft.imageUrl)) {
    errors.imageUrl = "Enter a valid URL (https://…).";
  }

  // Deploy-required registry fields for the selected type (e.g. issuer name,
  // peg currency) — required so the token can be deployed later.
  if (draft.assetCategory && draft.assetType) {
    const entry = getAssetTypeRegistryEntry(draft.assetCategory, draft.assetType);
    for (const path of entry?.requiredForDeploy ?? []) {
      const field = DEPLOY_PATH_TO_FIELD[path];
      if (!field || errors[field]) {
        continue;
      }
      if (!String(draft[field] ?? "").trim()) {
        errors[field] = `${pathLabel(path)} is required.`;
      }
    }
  }

  return errors;
}

// Hard blockers that prevent creating the draft at all.
export function getBlockers(draft: DraftState): string[] {
  const blockers: string[] = [];
  if (!draft.assetCategory || !draft.assetType) {
    blockers.push("Choose a classification and sub asset type.");
  }
  if (!draft.name.trim()) {
    blockers.push("Asset name is required.");
  }
  for (const message of Object.values(getAssetDetailsErrors(draft))) {
    blockers.push(message);
  }
  return blockers;
}
