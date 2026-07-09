import { type AssetCategory, getAssetTypeRegistryEntry, type IssuanceMetadata } from "@sdp/types";
import { detailFieldOptionLabel } from "./asset-details-config";
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

  const base = pruneEmpty({ asset, compliance, chain, custom });
  // Only persist an explicit `visibility` selection when it differs from the
  // type's registry default. When it matches, we leave `visibility` off and let
  // the server fall back to the default projection — keeping metadata minimal
  // and load-then-save idempotent. Attached outside pruneEmpty so a non-default
  // (including empty) selection always survives; the server clamps it to
  // public-safe paths before projecting.
  const defaults =
    draft.assetCategory && draft.assetType
      ? getDefaultPublicFields(draft.assetCategory, draft.assetType)
      : [];
  if (samePathSet(draft.publicFields, defaults)) {
    return base as IssuanceMetadata;
  }
  return { ...base, visibility: { public: draft.publicFields } } as IssuanceMetadata;
}

// Order-independent equality of two dot-path selections.
function samePathSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) {
    return false;
  }
  for (const path of left) {
    if (!right.has(path)) {
      return false;
    }
  }
  return true;
}

const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function getByPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  if (keys.some((key) => BLOCKED_PATH_SEGMENTS.has(key))) {
    return;
  }
  let node = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (typeof node[key] !== "object" || node[key] === null) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

// Identity metadata paths that are always public — the locked rows in the
// public-info preview. (Symbol, category, asset type, and logo live on the
// token record / are derived, so they aren't part of IssuanceMetadata.)
const ALWAYS_PUBLIC_METADATA_PATHS = ["asset.name", "asset.description", "chain.decimals"];

// The public projection of the issuance metadata: only the dot-paths actually
// published — the always-public identity fields plus the issuer's enabled
// optional selections. Mirrors what the platform exposes publicly, so the
// Public information step can show a faithful "public metadata" JSON.
export function buildPublicMetadata(draft: DraftState): IssuanceMetadata {
  const metadata = buildIssuanceMetadata(draft);
  const paths = new Set<string>([...ALWAYS_PUBLIC_METADATA_PATHS, ...draft.publicFields]);
  const projected: Record<string, unknown> = {};
  for (const path of paths) {
    const value = getByPath(metadata, path);
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
      continue;
    }
    setByPath(projected, path, value);
  }
  return projected as IssuanceMetadata;
}

const PATH_LABELS: Record<string, string> = {
  "asset.name": "Name",
  "asset.description": "Description",
  "asset.issuerName": "Issuer name",
  "asset.pegCurrency": "Peg currency",
  "asset.pegTarget": "Peg target",
  "asset.backingType": "Backing type",
  "asset.reserveAsset": "Reserve asset",
  "asset.reserveCustodian": "Reserve custodian",
  "asset.website": "Website",
  "asset.jurisdiction": "Jurisdiction",
  "asset.offeringType": "Offering type",
  "asset.underlyingAsset": "Underlying asset",
  "asset.custodian": "Custodian",
  "chain.decimals": "Decimals",
};

// The asset.* metadata fields the issuer may expose or keep private on the
// Public information step. Token identity (name/symbol/decimals/description/logo)
// and classification are inherently public and are NOT part of this pool.
export const PUBLIC_FIELD_POOL: readonly { path: string; label: string }[] = [
  { path: "asset.issuerName", label: PATH_LABELS["asset.issuerName"] },
  { path: "asset.pegCurrency", label: PATH_LABELS["asset.pegCurrency"] },
  { path: "asset.pegTarget", label: PATH_LABELS["asset.pegTarget"] },
  { path: "asset.backingType", label: PATH_LABELS["asset.backingType"] },
  { path: "asset.reserveAsset", label: PATH_LABELS["asset.reserveAsset"] },
  { path: "asset.reserveCustodian", label: PATH_LABELS["asset.reserveCustodian"] },
  { path: "asset.website", label: PATH_LABELS["asset.website"] },
  { path: "asset.jurisdiction", label: PATH_LABELS["asset.jurisdiction"] },
  { path: "asset.offeringType", label: PATH_LABELS["asset.offeringType"] },
  { path: "asset.underlyingAsset", label: PATH_LABELS["asset.underlyingAsset"] },
  { path: "asset.custodian", label: PATH_LABELS["asset.custodian"] },
];

export function pathLabel(path: string): string {
  if (PATH_LABELS[path]) {
    return PATH_LABELS[path];
  }
  const last = path.split(".").pop() ?? path;
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

// The per-type default public selection (the preselect). The registry's
// publicProjection doubles as the default set of published dot-paths.
export function getDefaultPublicFields(category: AssetCategory, type: string): string[] {
  const entry = getAssetTypeRegistryEntry(category, type);
  return entry ? [...entry.publicProjection] : [];
}

export interface PublicFieldCandidate {
  path: string;
  label: string;
  value: string;
  enabled: boolean;
}

// The toggleable public fields that currently have a value, each with its
// public on/off state. Drives the interactive public-info UI: identity and
// classification are inherently public and never appear here.
export function getPublicFieldCandidates(draft: DraftState): PublicFieldCandidate[] {
  const metadata = buildIssuanceMetadata(draft);
  const enabled = new Set(draft.publicFields);
  return PUBLIC_FIELD_POOL.flatMap(({ path, label }) => {
    const raw = getByPath(metadata, path);
    const rawValue = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
    if (!rawValue) {
      return [];
    }
    // Select-backed fields (backingType, jurisdiction, offeringType, …) store
    // their system value (e.g. "fiat"); show the human label wherever one is
    // defined, falling back to the raw value for free-text fields.
    const key = path.split(".").pop() ?? path;
    const value = detailFieldOptionLabel(key, rawValue) ?? rawValue;
    return [{ path, label, value, enabled: enabled.has(path) }];
  });
}

// Add or remove a dot-path from the published set (dedup-safe).
export function togglePublicField(current: string[], path: string, enabled: boolean): string[] {
  const next = new Set(current);
  if (enabled) {
    next.add(path);
  } else {
    next.delete(path);
  }
  return [...next];
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

// Guards any user-supplied URL that becomes an anchor `href`: returns the URL
// only when it's a safe http(s) link, else undefined — so a `javascript:` (or
// other) scheme can never execute in the app's origin. Callers render a link
// only when this returns a value, and fall back to plain text otherwise.
export function safeLinkHref(value: string): string | undefined {
  return isValidUrl(value) ? value.trim() : undefined;
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
