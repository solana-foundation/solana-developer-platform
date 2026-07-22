import type { AssetProfile, IssuanceMetadata, Token } from "@sdp/types";
import { getDefaultPublicFields } from "../../create/draft-mapping";
import {
  type AdvancedSettingsDraft,
  CAPACITY_KEYS,
  type CustomFieldRow,
  coerceCapacities,
  type DocumentRow,
  type DraftState,
} from "../../create/issuance-draft-wizard.types";

// The metadata keys the edit form owns per namespace. The clobber-safe merge
// only overwrites/deletes these; every other key an integration may have
// written into the profile is carried through untouched.
export const ASSET_OWNED_KEYS = [
  "name",
  "description",
  "website",
  "issuerName",
  "backingType",
  "pegCurrency",
  "pegTarget",
  "reserveAsset",
  "reserveCustodian",
  "redemptionEnabled",
  "collateralizationRatio",
  "oracleProvider",
  "minCollateralRatio",
  "jurisdiction",
  "offeringType",
  "shareClass",
  "votingRights",
  "couponRate",
  "maturityDate",
  "seniority",
  "fundStrategy",
  "managementFee",
  "netAssetValue",
  "underlyingAsset",
  "custodian",
  "propertyType",
  "propertyLocation",
  "documents",
] as const;

export const COMPLIANCE_OWNED_KEYS = ["accessControl", "capacities"] as const;

export const CHAIN_OWNED_KEYS = ["decimals"] as const;

export interface UpdateAssetProfileActionInput {
  tokenId: string;
  profileId: string;
  // buildIssuanceMetadata(draft) — contains only form-owned keys; merged over
  // the freshly fetched profile server-side before the PATCH.
  rebuiltMetadata: IssuanceMetadata;
  tokenPatch: {
    name: string;
    description: string | null;
    uri: string | null;
    imageUrl: string | null;
    // Only sent while the token is undeployed (the API rejects it after deploy).
    requiresAllowlist?: boolean;
  };
}

export interface UpdateAssetProfileActionResult {
  state: "success" | "error";
  message: string;
  assetProfile: AssetProfile | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function readDocuments(value: unknown): DocumentRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: DocumentRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = readString(entry, "name");
    const url = readString(entry, "url");
    if (!name && !url) {
      continue;
    }
    rows.push({ id: crypto.randomUUID(), docType: readString(entry, "type"), name, url });
  }
  return rows;
}

function readAccessControl(value: unknown): DraftState["accessControl"] {
  return value === "allowlist" || value === "blocklist" || value === "disabled" ? value : "";
}

// The persisted advanced-settings selection, hydrated back into draft shape
// (params as strings). Absent (legacy profiles) ⇒ empty selection.
function readAdvancedSettings(value: unknown): AdvancedSettingsDraft {
  const result: AdvancedSettingsDraft = {};
  if (isRecord(value) && isRecord(value.selected)) {
    for (const [key, selection] of Object.entries(value.selected)) {
      const params: Record<string, string> = {};
      if (isRecord(selection) && isRecord(selection.params)) {
        for (const [paramKey, paramValue] of Object.entries(selection.params)) {
          if (typeof paramValue === "string") {
            params[paramKey] = paramValue;
          } else if (typeof paramValue === "number") {
            params[paramKey] = String(paramValue);
          }
        }
      }
      result[key] = Object.keys(params).length > 0 ? { params } : {};
    }
  }
  return result;
}

// The persisted public-field selection, if any. Absent (legacy profiles) ⇒ null
// so the caller can fall back to the type's registry default.
function readPublicFields(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.public)) {
    return null;
  }
  return value.public.filter((path): path is string => typeof path === "string");
}

// Only string values become editable rows; non-string values (integration
// config objects, numbers, …) stay out of the form and are preserved by the
// merge on save.
function readCustomFields(customer: Record<string, unknown>): CustomFieldRow[] {
  return Object.entries(customer)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => ({ id: crypto.randomUUID(), key, value }));
}

/**
 * Hydrate the creation-flow form model from an existing profile + token.
 *
 * The token row wins for the fields it duplicates (name, symbol, decimals,
 * description, imageUrl, uri, signingWalletId): it is what deploy and the rest
 * of the dashboard read, and the profile's copies can lag behind token-only
 * updates made from the old management UI. Saving re-converges both.
 */
export function profileToDraftState(profile: AssetProfile, token: Token): DraftState {
  const metadata = profile.issuanceMetadata ?? {};
  const asset = isRecord(metadata.asset) ? metadata.asset : {};
  const compliance = isRecord(metadata.compliance) ? metadata.compliance : {};
  const custom = isRecord(metadata.custom) ? metadata.custom : {};
  const customer = isRecord(custom.customer) ? custom.customer : {};
  const publicFields =
    readPublicFields(metadata.visibility) ??
    getDefaultPublicFields(profile.assetCategory, profile.assetType);

  return {
    assetCategory: profile.assetCategory,
    assetType: profile.assetType,
    name: token.name,
    symbol: token.symbol,
    decimals: String(token.decimals),
    description: token.description ?? readString(asset, "description"),
    website: readString(asset, "website"),
    imageUrl: token.imageUrl ?? "",
    backingType: readString(asset, "backingType"),
    pegCurrency: readString(asset, "pegCurrency"),
    pegTarget: readString(asset, "pegTarget"),
    reserveAsset: readString(asset, "reserveAsset"),
    reserveCustodian: readString(asset, "reserveCustodian"),
    redemptionEnabled: asset.redemptionEnabled === true,
    collateralizationRatio: readString(asset, "collateralizationRatio"),
    oracleProvider: readString(asset, "oracleProvider"),
    minCollateralRatio: readString(asset, "minCollateralRatio"),
    issuerName: readString(asset, "issuerName"),
    jurisdiction: readString(asset, "jurisdiction"),
    offeringType: readString(asset, "offeringType"),
    shareClass: readString(asset, "shareClass"),
    votingRights: asset.votingRights === true,
    couponRate: readString(asset, "couponRate"),
    maturityDate: readString(asset, "maturityDate"),
    seniority: readString(asset, "seniority"),
    fundStrategy: readString(asset, "fundStrategy"),
    managementFee: readString(asset, "managementFee"),
    netAssetValue: readString(asset, "netAssetValue"),
    underlyingAsset: readString(asset, "underlyingAsset"),
    custodian: readString(asset, "custodian"),
    propertyType: readString(asset, "propertyType"),
    propertyLocation: readString(asset, "propertyLocation"),
    documents: readDocuments(asset.documents),
    accessControl: readAccessControl(compliance.accessControl),
    capacities: coerceCapacities(compliance.capacities),
    advancedSettings: readAdvancedSettings(metadata.settings),
    signingWalletId: token.signingWalletId ?? "",
    metadataUri: token.uri ?? "",
    customFields: readCustomFields(customer),
    publicFields,
  };
}

function mergeNamespace(
  merged: Record<string, unknown>,
  rebuilt: IssuanceMetadata,
  namespace: "asset" | "compliance" | "chain",
  ownedKeys: readonly string[]
): void {
  const rebuiltNs = isRecord(rebuilt[namespace]) ? rebuilt[namespace] : {};
  const existingNs = isRecord(merged[namespace]) ? merged[namespace] : {};

  for (const key of ownedKeys) {
    if (key in rebuiltNs) {
      existingNs[key] = rebuiltNs[key];
    } else {
      // buildIssuanceMetadata prunes empty values, so an owned key absent from
      // the rebuilt metadata means the user cleared that field.
      delete existingNs[key];
    }
  }

  if (Object.keys(existingNs).length > 0) {
    merged[namespace] = existingNs;
  } else {
    delete merged[namespace];
  }
}

/**
 * Merge the form's rebuilt metadata over the freshly fetched profile metadata.
 *
 * PATCH replaces the whole issuanceMetadata object, but the form only knows the
 * wizard-owned keys — a plain replace would silently drop custom.integration,
 * unknown namespaces, and unknown keys inside asset/compliance written by
 * integrations. Owned keys are overwritten (or deleted when cleared); all other
 * data survives untouched.
 */
export function mergeIssuanceMetadataForUpdate(
  existing: IssuanceMetadata | undefined,
  rebuilt: IssuanceMetadata
): IssuanceMetadata {
  const merged: Record<string, unknown> = structuredClone(existing ?? {});

  mergeNamespace(merged, rebuilt, "asset", ASSET_OWNED_KEYS);
  mergeNamespace(merged, rebuilt, "compliance", COMPLIANCE_OWNED_KEYS);
  mergeNamespace(merged, rebuilt, "chain", CHAIN_OWNED_KEYS);

  const existingCustom = isRecord(merged.custom) ? merged.custom : {};
  const existingCustomer = isRecord(existingCustom.customer) ? existingCustom.customer : {};
  const rebuiltCustom = isRecord(rebuilt.custom) ? rebuilt.custom : {};
  const rebuiltCustomer = isRecord(rebuiltCustom.customer) ? rebuiltCustom.customer : {};

  // The form edits string-valued customer entries only: drop those, keep
  // non-string entries, then apply the form's rows.
  const nextCustomer: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existingCustomer)) {
    if (typeof value !== "string") {
      nextCustomer[key] = value;
    }
  }
  Object.assign(nextCustomer, rebuiltCustomer);

  if (Object.keys(nextCustomer).length > 0) {
    existingCustom.customer = nextCustomer;
  } else {
    delete existingCustom.customer;
  }
  if (Object.keys(existingCustom).length > 0) {
    merged.custom = existingCustom;
  } else {
    delete merged.custom;
  }

  // Visibility is form-owned: the rebuilt metadata always carries the current
  // public-field selection, so `public` is overwritten (or cleared when the
  // form omits it) while any other visibility keys survive.
  const existingVisibility = isRecord(merged.visibility) ? merged.visibility : {};
  const rebuiltVisibility = isRecord(rebuilt.visibility) ? rebuilt.visibility : {};
  if ("public" in rebuiltVisibility) {
    existingVisibility.public = rebuiltVisibility.public;
  } else {
    delete existingVisibility.public;
  }
  if (Object.keys(existingVisibility).length > 0) {
    merged.visibility = existingVisibility;
  } else {
    delete merged.visibility;
  }

  // Settings is a wholly form-owned namespace (no integration writes there), so
  // the rebuilt selection replaces it outright — or clears it when empty.
  if (isRecord(rebuilt.settings)) {
    merged.settings = rebuilt.settings;
  } else {
    delete merged.settings;
  }

  return merged as IssuanceMetadata;
}

function canonicalDraft(draft: DraftState): Record<string, unknown> {
  return {
    assetCategory: draft.assetCategory,
    assetType: draft.assetType,
    name: draft.name.trim(),
    symbol: draft.symbol.trim(),
    decimals: draft.decimals.trim(),
    description: draft.description.trim(),
    website: draft.website.trim(),
    imageUrl: draft.imageUrl.trim(),
    backingType: draft.backingType,
    pegCurrency: draft.pegCurrency,
    pegTarget: draft.pegTarget.trim(),
    reserveAsset: draft.reserveAsset.trim(),
    reserveCustodian: draft.reserveCustodian.trim(),
    redemptionEnabled: draft.redemptionEnabled,
    collateralizationRatio: draft.collateralizationRatio.trim(),
    oracleProvider: draft.oracleProvider.trim(),
    minCollateralRatio: draft.minCollateralRatio.trim(),
    issuerName: draft.issuerName.trim(),
    jurisdiction: draft.jurisdiction,
    offeringType: draft.offeringType,
    shareClass: draft.shareClass.trim(),
    votingRights: draft.votingRights,
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
    // Mirror buildIssuanceMetadata's filter: a row with only a type (no name or
    // url) is never persisted or re-hydrated, so it must not read as a change —
    // otherwise a type-only row leaves the form permanently "dirty".
    documents: draft.documents
      .filter((doc) => doc.name.trim() || doc.url.trim())
      .map((doc) => ({ docType: doc.docType.trim(), name: doc.name.trim(), url: doc.url.trim() })),
    accessControl: draft.accessControl,
    // Normalize to { enabled, config } per key so both the enable bit and the
    // per-policy config participate in dirty detection (config ?? null keeps
    // key order stable for the comparison).
    capacities: CAPACITY_KEYS.map((key) => ({
      enabled: draft.capacities[key].enabled,
      config: draft.capacities[key].config ?? null,
    })),
    // Mirror buildSelectedSettings: sorted keys, trimmed non-empty params only,
    // so presentation noise never reads as a change.
    advancedSettings: Object.keys(draft.advancedSettings)
      .sort()
      .map((key) => ({
        key,
        params: Object.entries(draft.advancedSettings[key].params ?? {})
          .filter(([, paramValue]) => paramValue.trim() !== "")
          .map(([paramKey, paramValue]) => [paramKey, paramValue.trim()])
          .sort(([a], [b]) => a.localeCompare(b)),
      })),
    signingWalletId: draft.signingWalletId.trim(),
    metadataUri: draft.metadataUri.trim(),
    customFields: draft.customFields
      .filter((field) => field.key.trim() || field.value.trim())
      .map((field) => ({ key: field.key.trim(), value: field.value.trim() })),
    // Sorted so a pure reordering never reads as a change.
    publicFields: [...draft.publicFields].sort(),
  };
}

// Dirty check that ignores presentation noise: whitespace, generated row ids,
// and rows that are still entirely empty.
export function areDraftsEquivalent(a: DraftState, b: DraftState): boolean {
  return JSON.stringify(canonicalDraft(a)) === JSON.stringify(canonicalDraft(b));
}
