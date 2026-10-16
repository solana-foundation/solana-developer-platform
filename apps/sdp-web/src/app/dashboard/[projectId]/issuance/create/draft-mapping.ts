import {
  ADVANCED_SETTINGS,
  AUTHORITY_VALUED_SETTINGS,
  findIncompatibleExtensionPair,
  type SettingKey,
} from "@sdp/issuance/capabilities";
import { decimalScale, isDecimalString } from "@sdp/solana/amount";
import {
  type AdvancedSetting,
  type AssetCategory,
  getAssetTypeRegistryEntry,
  type IssuanceMetadata,
} from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import {
  type AdvancedSettingsDraft,
  CAPACITY_KEYS,
  type DraftState,
  isValidDecimals,
} from "./issuance-draft-wizard.types";

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
  const customerWithAuthorities = {
    ...customer,
    ...(draft.authorityWalletIds ? { authorityWalletIds: draft.authorityWalletIds } : {}),
  };
  const custom = pruneEmpty({
    customer: Object.keys(customerWithAuthorities).length > 0 ? customerWithAuthorities : undefined,
  });

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

export function pathLabel(path: string, t: Translate): string {
  return t(PATH_LABEL_KEYS[path] ?? "DashboardIssuance.errors.field");
}

// The per-type default public selection (the preselect). The registry's
// publicProjection doubles as the default set of published dot-paths.
export function getDefaultPublicFields(category: AssetCategory, type: string): string[] {
  const entry = getAssetTypeRegistryEntry(category, type);
  return entry ? [...entry.publicProjection] : [];
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

// An enabled setting with a required, still-empty parameter (e.g. a transfer fee
// toggled on but no basis-points entered). Drives the editor's inline errors.
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

// Max supply is optional — blank means uncapped. When set it must be a positive
// decimal the mint can actually represent: the API parses it against the token's
// decimals and rejects excess precision. Scale is checked against the draft's
// decimals because the resolver only substitutes a template default when decimals
// is omitted (`decimalsOverride ?? definition.decimals`) and the edit form
// carries the mint's decimals. Returns undefined when there is nothing to report.
function maxSupplyError(draft: DraftState, t: Translate): string | undefined {
  const maxSupply = draft.maxSupply.trim();
  if (!maxSupply) {
    return undefined;
  }
  // isDecimalString already rejects signs, so this only has to rule out zero.
  if (!isDecimalString(maxSupply) || !/[1-9]/.test(maxSupply)) {
    return t("DashboardIssuance.errors.maxSupplyPositive");
  }
  if (isValidDecimals(draft.decimals) && decimalScale(maxSupply) > Number(draft.decimals.trim())) {
    return t("DashboardIssuance.errors.maxSupplyPrecision", { decimals: draft.decimals.trim() });
  }
  return undefined;
}

// Per-field validation for the required Asset-details fields — empty or badly
// formatted entries map to a user-facing message, keyed by draft field. Drives
// the Asset Profile edit form's validation.
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

  const maxSupplyMessage = maxSupplyError(draft, t);
  if (maxSupplyMessage) {
    errors.maxSupply = maxSupplyMessage;
  }

  const description = draft.description.trim();
  if (description.length > ASSET_DESCRIPTION_MAX_LENGTH) {
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
