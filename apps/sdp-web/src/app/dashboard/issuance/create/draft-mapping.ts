import {
  ADVANCED_SETTINGS,
  AUTHORITY_VALUED_SETTINGS,
  findIncompatibleExtensionPair,
  getRecommendedSettings,
  isSettingAllowed,
  pruneIncompatibleSettings,
  resolveSettingsToExtensions,
  type SettingKey,
} from "@sdp/issuance/capabilities";
import {
  type AdvancedSetting,
  type AssetCategory,
  getAssetTypeRegistryEntry,
  type IssuanceMetadata,
  type TokenExtensionsConfig,
  type TokenTemplate,
} from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { detailFieldOptionLabel } from "./asset-details-config";
import {
  type AdvancedSettingsDraft,
  CAPACITY_KEYS,
  type DraftState,
  isValidDecimals,
} from "./issuance-draft-wizard.types";

// Recommended advanced settings for an asset type, pre-filled with each
// parametric setting's default param values. Applied when a type is chosen (the
// "recommended options are pre-selected" behaviour), mirroring
// getRecommendedCapacities / getDefaultPublicFields.
export function getRecommendedAdvancedSettings(
  category: AssetCategory,
  type: string
): AdvancedSettingsDraft {
  const result: AdvancedSettingsDraft = {};
  for (const key of getRecommendedSettings(category, type)) {
    const setting: AdvancedSetting = ADVANCED_SETTINGS[key];
    const params: Record<string, string> = {};
    for (const param of setting.params ?? []) {
      if (param.defaultValue !== undefined) {
        params[param.key] = String(param.defaultValue);
      }
    }
    result[key] = Object.keys(params).length > 0 ? { params } : {};
  }
  return result;
}

// Re-validate a persisted advanced-settings selection against the current rules.
// Drops settings the asset type no longer allows and any that would form an
// incompatible extension pair (keeping the earlier one). Runs on hydration so a
// stale localStorage draft can't restore a combination the editor would never
// let you build — e.g. two conflicting extensions both left checked.
export function sanitizeAdvancedSettings(
  category: AssetCategory | null,
  type: string | null,
  advancedSettings: AdvancedSettingsDraft
): AdvancedSettingsDraft {
  const original = Object.keys(advancedSettings);
  // 1. Keep only keys valid for the type (or, before a type is chosen, only
  //    known catalog keys).
  const allowed =
    category && type
      ? original.filter((key) => isSettingAllowed(category, type, key))
      : original.filter((key) => key in ADVANCED_SETTINGS);
  // 2. Drop conflicting settings, keeping the earlier-listed one.
  const kept = new Set<string>(pruneIncompatibleSettings(allowed));
  const result: AdvancedSettingsDraft = {};
  for (const key of original) {
    if (kept.has(key)) {
      result[key] = advancedSettings[key];
    }
  }
  return result;
}

// Convert the draft's advanced-settings selection into the persisted
// issuance_metadata.settings.selected shape, dropping empty param strings.
function buildSelectedSettings(
  advancedSettings: AdvancedSettingsDraft
): Record<string, { params?: Record<string, string> }> {
  const selected: Record<string, { params?: Record<string, string> }> = {};
  for (const [key, selection] of Object.entries(advancedSettings)) {
    const params: Record<string, string> = {};
    for (const [paramKey, paramValue] of Object.entries(selection.params ?? {})) {
      if (paramValue.trim() !== "") {
        params[paramKey] = paramValue.trim();
      }
    }
    selected[key] = Object.keys(params).length > 0 ? { params } : {};
  }
  return selected;
}

const SYMBOL_RE = /^[A-Za-z0-9.]{1,10}$/;
// Mirrors the API's `description: z.string().max(500)` (create/updateTokenSchema)
// so an over-long value is caught inline, not on a late 400.
export const ASSET_DESCRIPTION_MAX_LENGTH = 500;
type Translate = (key: MessageKey, values?: TranslationValues) => string;

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

// A best-effort preview of what the draft's advanced settings compile to at deploy
// time — the resolver output (base template, decimals, allowlist, and the resolved
// Token-2022 extension config). Authorities are deliberately omitted: mint/freeze/
// delegate are assigned server-side from the signing wallet's custody at deploy, so
// the client can't show the real on-chain values (the resolver omits an authority
// rather than emit a bricking placeholder). Returns null before a category/type is
// chosen — nothing to resolve yet.
export interface DeployConfigPreview {
  template: TokenTemplate;
  decimals: number;
  requiresAllowlist: boolean;
  extensions: TokenExtensionsConfig | null;
}

export function buildDeployConfigPreview(draft: DraftState): DeployConfigPreview | null {
  if (!draft.assetCategory || !draft.assetType) {
    return null;
  }
  const selected = buildSelectedSettings(
    sanitizeAdvancedSettings(draft.assetCategory, draft.assetType, draft.advancedSettings)
  );
  const decimals = Number(draft.decimals);
  const resolution = resolveSettingsToExtensions(draft.assetCategory, draft.assetType, selected, {
    decimals: Number.isFinite(decimals) ? decimals : 0,
    requiresAllowlist: draft.accessControl === "allowlist",
  });
  return {
    template: resolution.template,
    decimals: resolution.decimals,
    requiresAllowlist: resolution.requiresAllowlist,
    extensions: resolution.extensions,
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
    // Set from the chosen sub-type at classification time for typed stablecoins
    // (see impliedBackingType) so it can't contradict the type; issuer-entered
    // for a generic stablecoin. Reflected verbatim here to keep load-then-save
    // idempotent — no value is synthesized during the metadata build.
    backingType: draft.backingType,
    pegCurrency: draft.pegCurrency,
    pegTarget: draft.pegTarget.trim(),
    reserveAsset: draft.reserveAsset.trim(),
    reserveCustodian: draft.reserveCustodian.trim(),
    redemptionEnabled: draft.redemptionEnabled ? true : undefined,
    collateralizationRatio: draft.collateralizationRatio.trim(),
    oracleProvider: draft.oracleProvider.trim(),
    minCollateralRatio: draft.minCollateralRatio.trim(),
    jurisdiction: draft.jurisdiction,
    offeringType: draft.offeringType,
    shareClass: draft.shareClass.trim(),
    votingRights: draft.votingRights ? true : undefined,
    couponRate: draft.couponRate.trim(),
    maturityDate: draft.maturityDate.trim(),
    seniority: draft.seniority,
    fundStrategy: draft.fundStrategy,
    managementFee: draft.managementFee.trim(),
    netAssetValue: draft.netAssetValue.trim(),
    underlyingAsset: draft.underlyingAsset.trim(),
    custodian: draft.custodian.trim(),
    propertyType: draft.propertyType,
    propertyLocation: draft.propertyLocation.trim(),
    documents: draft.documents
      .filter((doc) => doc.name.trim() || doc.url.trim())
      .map((doc) => ({ type: doc.docType.trim(), name: doc.name.trim(), url: doc.url.trim() })),
  });

  // Off-chain capacities: presence = enabled. Store `{ enabled: true, config? }`
  // (not a bare `{}`) so pruneEmpty keeps an enabled-but-unconfigured policy —
  // it drops empty objects. Disabled ⇒ undefined ⇒ pruned. readCapacities also
  // accepts the legacy `{ key: true }` boolean encoding.
  const capacities = pruneEmpty(
    Object.fromEntries(
      CAPACITY_KEYS.map((key) => {
        const selection = draft.capacities[key];
        if (!selection.enabled) {
          return [key, undefined];
        }
        return [
          key,
          selection.config ? { enabled: true, config: selection.config } : { enabled: true },
        ];
      })
    )
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

  const selectedSettings = buildSelectedSettings(draft.advancedSettings);
  const settings =
    Object.keys(selectedSettings).length > 0 ? { selected: selectedSettings } : undefined;

  const base = pruneEmpty({ asset, compliance, chain, custom, settings });
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

const PATH_LABEL_KEYS: Record<string, MessageKey> = {
  "asset.name": "DashboardIssuance.forms.name",
  "asset.description": "DashboardIssuance.forms.description",
  "asset.issuerName": "DashboardIssuance.config.issuerName",
  "asset.pegCurrency": "DashboardIssuance.config.currency",
  "asset.pegTarget": "DashboardIssuance.config.pegTarget",
  "asset.backingType": "DashboardIssuance.config.backingType",
  "asset.reserveAsset": "DashboardIssuance.config.reserveAsset",
  "asset.reserveCustodian": "DashboardIssuance.config.reserveCustodian",
  "asset.collateralizationRatio": "DashboardIssuance.config.collateralizationRatio",
  "asset.oracleProvider": "DashboardIssuance.config.oracleProvider",
  "asset.minCollateralRatio": "DashboardIssuance.config.minCollateralRatio",
  "asset.website": "DashboardIssuance.review.website",
  "asset.jurisdiction": "DashboardIssuance.config.jurisdiction",
  "asset.offeringType": "DashboardIssuance.config.offeringType",
  "asset.shareClass": "DashboardIssuance.config.shareClass",
  "asset.votingRights": "DashboardIssuance.config.votingRights",
  "asset.couponRate": "DashboardIssuance.config.couponRate",
  "asset.maturityDate": "DashboardIssuance.config.maturityDate",
  "asset.seniority": "DashboardIssuance.config.seniority",
  "asset.fundStrategy": "DashboardIssuance.config.fundStrategy",
  "asset.managementFee": "DashboardIssuance.config.managementFee",
  "asset.netAssetValue": "DashboardIssuance.config.netAssetValue",
  "asset.underlyingAsset": "DashboardIssuance.config.underlyingAsset",
  "asset.custodian": "DashboardIssuance.config.custodian",
  "asset.propertyType": "DashboardIssuance.config.propertyType",
  "asset.propertyLocation": "DashboardIssuance.config.propertyLocation",
  "chain.decimals": "DashboardIssuance.create.decimals",
};

// The asset.* metadata fields the issuer may expose or keep private on the
// Public information step. Token identity (name/symbol/decimals/description/logo)
// and classification are inherently public and are NOT part of this pool.
export const PUBLIC_FIELD_POOL: readonly { path: string; labelKey: MessageKey }[] = [
  { path: "asset.issuerName", labelKey: PATH_LABEL_KEYS["asset.issuerName"] },
  { path: "asset.pegCurrency", labelKey: PATH_LABEL_KEYS["asset.pegCurrency"] },
  { path: "asset.pegTarget", labelKey: PATH_LABEL_KEYS["asset.pegTarget"] },
  { path: "asset.backingType", labelKey: PATH_LABEL_KEYS["asset.backingType"] },
  { path: "asset.reserveAsset", labelKey: PATH_LABEL_KEYS["asset.reserveAsset"] },
  { path: "asset.reserveCustodian", labelKey: PATH_LABEL_KEYS["asset.reserveCustodian"] },
  {
    path: "asset.collateralizationRatio",
    labelKey: PATH_LABEL_KEYS["asset.collateralizationRatio"],
  },
  { path: "asset.oracleProvider", labelKey: PATH_LABEL_KEYS["asset.oracleProvider"] },
  { path: "asset.minCollateralRatio", labelKey: PATH_LABEL_KEYS["asset.minCollateralRatio"] },
  { path: "asset.website", labelKey: PATH_LABEL_KEYS["asset.website"] },
  { path: "asset.jurisdiction", labelKey: PATH_LABEL_KEYS["asset.jurisdiction"] },
  { path: "asset.offeringType", labelKey: PATH_LABEL_KEYS["asset.offeringType"] },
  { path: "asset.shareClass", labelKey: PATH_LABEL_KEYS["asset.shareClass"] },
  { path: "asset.votingRights", labelKey: PATH_LABEL_KEYS["asset.votingRights"] },
  { path: "asset.couponRate", labelKey: PATH_LABEL_KEYS["asset.couponRate"] },
  { path: "asset.maturityDate", labelKey: PATH_LABEL_KEYS["asset.maturityDate"] },
  { path: "asset.seniority", labelKey: PATH_LABEL_KEYS["asset.seniority"] },
  { path: "asset.fundStrategy", labelKey: PATH_LABEL_KEYS["asset.fundStrategy"] },
  { path: "asset.managementFee", labelKey: PATH_LABEL_KEYS["asset.managementFee"] },
  { path: "asset.netAssetValue", labelKey: PATH_LABEL_KEYS["asset.netAssetValue"] },
  { path: "asset.underlyingAsset", labelKey: PATH_LABEL_KEYS["asset.underlyingAsset"] },
  { path: "asset.custodian", labelKey: PATH_LABEL_KEYS["asset.custodian"] },
  { path: "asset.propertyType", labelKey: PATH_LABEL_KEYS["asset.propertyType"] },
  { path: "asset.propertyLocation", labelKey: PATH_LABEL_KEYS["asset.propertyLocation"] },
];

export function pathLabel(path: string, t: Translate): string {
  return t(PATH_LABEL_KEYS[path] ?? "DashboardIssuance.errors.field");
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
export function getPublicFieldCandidates(draft: DraftState, t: Translate): PublicFieldCandidate[] {
  const metadata = buildIssuanceMetadata(draft);
  const enabled = new Set(draft.publicFields);
  return PUBLIC_FIELD_POOL.flatMap(({ path, labelKey }) => {
    const raw = getByPath(metadata, path);
    // Boolean toggles (e.g. voting rights) only reach here when true — a false
    // toggle is pruned to undefined in the metadata — so show a human "Enabled"
    // rather than the literal "true".
    if (typeof raw === "boolean") {
      return raw
        ? [
            {
              path,
              label: t(labelKey),
              value: t("DashboardIssuance.review.enabled"),
              enabled: enabled.has(path),
            },
          ]
        : [];
    }
    const rawValue = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
    if (!rawValue) {
      return [];
    }
    // Select-backed fields (backingType, jurisdiction, offeringType, …) store
    // their system value (e.g. "fiat"); show the human label wherever one is
    // defined, falling back to the raw value for free-text fields.
    const key = path.split(".").pop() ?? path;
    const value = detailFieldOptionLabel(key, rawValue, t) ?? rawValue;
    return [{ path, label: t(labelKey), value, enabled: enabled.has(path) }];
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

// An enabled setting with a required, still-empty parameter (e.g. a transfer fee
// toggled on but no basis-points entered). Drives the Continue gate and the
// editor's inline field errors.
export function advancedSettingsHaveMissingParams(
  advancedSettings: AdvancedSettingsDraft
): boolean {
  for (const [key, selection] of Object.entries(advancedSettings)) {
    const setting: AdvancedSetting = ADVANCED_SETTINGS[key as SettingKey];
    if (!setting?.params) {
      continue;
    }
    for (const param of setting.params) {
      if (param.required && !String(selection.params?.[param.key] ?? "").trim()) {
        return true;
      }
    }
  }
  return false;
}

// Per-field validation for the required Asset-details fields — empty or badly
// formatted entries map to a user-facing message, keyed by draft field. Drives
// the form's inline errors, the Continue gate, and the review blockers.
export function getAssetDetailsErrors(
  draft: DraftState,
  t: Translate
): Partial<Record<keyof DraftState, string>> {
  const errors: Partial<Record<keyof DraftState, string>> = {};

  const symbol = draft.symbol.trim();
  if (!symbol) {
    errors.symbol = t("DashboardIssuance.errors.symbolRequired");
  } else if (!SYMBOL_RE.test(symbol)) {
    errors.symbol = t("DashboardIssuance.errors.symbolCharacters");
  }

  if (!isValidDecimals(draft.decimals)) {
    errors.decimals = t("DashboardIssuance.errors.decimalsWholeNumber");
  }

  const description = draft.description.trim();
  if (!description) {
    errors.description = t("DashboardIssuance.errors.descriptionRequired");
  } else if (description.length > ASSET_DESCRIPTION_MAX_LENGTH) {
    errors.description = t("DashboardIssuance.errors.descriptionTooLong", {
      max: ASSET_DESCRIPTION_MAX_LENGTH,
    });
  }

  // Website and logo are optional, but must be valid URLs when provided.
  if (draft.website.trim() && !isValidUrl(draft.website)) {
    errors.website = t("DashboardIssuance.errors.validUrl");
  }

  if (draft.imageUrl.trim() && !isValidUrl(draft.imageUrl)) {
    errors.imageUrl = t("DashboardIssuance.errors.validUrl");
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
        errors[field] = t("DashboardIssuance.errors.fieldRequired", { field: pathLabel(path, t) });
      }
    }
  }

  if (advancedSettingsHaveMissingParams(draft.advancedSettings)) {
    errors.advancedSettings = t("DashboardIssuance.errors.settingValuesRequired");
  }

  // Two enabled settings whose extensions can't coexist on one mint (e.g.
  // interest-bearing + scaled display). The editor blocks selecting both, but a
  // hydrated/legacy draft could still carry the pair — reject it here too.
  const selectedExtensions = Object.keys(draft.advancedSettings).flatMap((key) => {
    const setting: AdvancedSetting = ADVANCED_SETTINGS[key as SettingKey];
    return setting ? [...setting.extensions] : [];
  });
  if (findIncompatibleExtensionPair(selectedExtensions)) {
    errors.advancedSettings = t("DashboardIssuance.errors.settingConflict");
  }

  // Authority-valued settings (e.g. permanent delegate) bind an on-chain authority
  // to the signing wallet at deploy, so the server rejects the create without one.
  // Require it here so the user gets inline guidance instead of a late 400.
  const needsSigner = Object.keys(draft.advancedSettings).some((key) =>
    (AUTHORITY_VALUED_SETTINGS as readonly string[]).includes(key)
  );
  if (needsSigner && !draft.signingWalletId.trim()) {
    errors.signingWalletId = t("DashboardIssuance.errors.signerRequiredForSettings");
  }

  return errors;
}

// Hard blockers that prevent creating the draft at all.
export function getBlockers(draft: DraftState, t: Translate): string[] {
  const blockers: string[] = [];
  if (!draft.assetCategory || !draft.assetType) {
    blockers.push(t("DashboardIssuance.errors.classificationRequired"));
  }
  if (!draft.name.trim()) {
    blockers.push(t("DashboardIssuance.errors.assetNameRequired"));
  }
  for (const message of Object.values(getAssetDetailsErrors(draft, t))) {
    blockers.push(message);
  }
  return blockers;
}
