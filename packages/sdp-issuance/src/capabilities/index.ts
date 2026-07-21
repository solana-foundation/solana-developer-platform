// Advanced Settings capability foundation: setting catalog, capability registry, lookups.
// Mosaic-free (only @sdp/types + templates), safe for API/web/tests.

import type {
  AdvancedSetting,
  AssetCapability,
  AssetCategory,
  ParamFieldSpec,
  SelectedSetting,
  SettingAvailability,
} from "@sdp/types";
import { ASSET_TYPES } from "@sdp/types";
import {
  normalizeTemplateId,
  TEMPLATE_DEFINITIONS,
  type TemplateOverrideError,
} from "../templates/definitions";
import { ASSET_CAPABILITIES } from "./capabilities";
import {
  ADVANCED_SETTINGS,
  INCOMPATIBLE_EXTENSION_PAIRS,
  SETTING_KEYS,
  type SettingKey,
} from "./settings";

export {
  AUTHORITY_VALUED_SETTINGS,
  type ExtensionAuthorities,
  type ResolveSettingsOptions,
  resolveSettingsToExtensions,
  type SettingsResolution,
} from "./resolver";
export { findIncompatibleExtensionPair, INCOMPATIBLE_EXTENSION_PAIRS } from "./settings";
export {
  buildSupportMatrix,
  renderSupportMatrixMarkdown,
  type SupportMatrix,
  type SupportMatrixAvailabilityRow,
  type SupportMatrixSettingRow,
} from "./support-matrix";
export type { SettingKey, TemplateOverrideError };
export { ADVANCED_SETTINGS, ASSET_CAPABILITIES, SETTING_KEYS };

// Drop conflicting settings; sanitizes persisted selections.
export function pruneIncompatibleSettings(settingKeys: readonly string[]): SettingKey[] {
  const kept: SettingKey[] = [];
  const keptExtensions = new Set<string>();
  for (const key of settingKeys) {
    if (!(key in ADVANCED_SETTINGS)) {
      continue;
    }
    const setting: AdvancedSetting = ADVANCED_SETTINGS[key as SettingKey];
    const conflicts = setting.extensions.some((extension) =>
      INCOMPATIBLE_EXTENSION_PAIRS.some(
        ([a, b]) =>
          (extension === a && keptExtensions.has(b)) || (extension === b && keptExtensions.has(a))
      )
    );
    if (conflicts) {
      continue;
    }
    kept.push(key as SettingKey);
    for (const extension of setting.extensions) {
      keptExtensions.add(extension);
    }
  }
  return kept;
}

// Settings whose extensions clash with this one (derived from INCOMPATIBLE_EXTENSION_PAIRS).
export function getConflictingSettingKeys(settingKey: SettingKey): SettingKey[] {
  const source: AdvancedSetting = ADVANCED_SETTINGS[settingKey];
  const blocked = new Set<SettingKey>();
  for (const pair of INCOMPATIBLE_EXTENSION_PAIRS) {
    const other = source.extensions.includes(pair[0])
      ? pair[1]
      : source.extensions.includes(pair[1])
        ? pair[0]
        : null;
    if (!other) {
      continue;
    }
    for (const key of SETTING_KEYS) {
      const candidate: AdvancedSetting = ADVANCED_SETTINGS[key];
      if (key !== settingKey && candidate.extensions.includes(other)) {
        blocked.add(key);
      }
    }
  }
  return [...blocked];
}

export function resolveAssetCapability(
  category: AssetCategory,
  type: string
): AssetCapability | undefined {
  return ASSET_CAPABILITIES.find((c) => c.category === category && c.type === type);
}

export function getRecommendedSettings(category: AssetCategory, type: string): SettingKey[] {
  const capability = resolveAssetCapability(category, type);
  if (!capability) {
    return [];
  }
  return SETTING_KEYS.filter(
    (key) => capability.settings[key] === "recommended" || capability.settings[key] === "locked"
  );
}

// Settings forced on (checked-and-disabled); undeselectable.
export function getLockedSettings(category: AssetCategory, type: string): SettingKey[] {
  const capability = resolveAssetCapability(category, type);
  if (!capability) {
    return [];
  }
  return SETTING_KEYS.filter((key) => capability.settings[key] === "locked");
}

// Single gate to check if an asset type permits a setting (locked/recommended/available).
export function isSettingAllowed(
  category: AssetCategory,
  type: string,
  settingKey: string
): boolean {
  const capability = resolveAssetCapability(category, type);
  if (!capability) {
    return false;
  }
  const availability = capability.settings[settingKey];
  return (
    availability === "locked" || availability === "recommended" || availability === "available"
  );
}

export interface GroupedSetting {
  key: SettingKey;
  setting: AdvancedSetting;
  availability: SettingAvailability;
}

export function listSettingsForType(category: AssetCategory, type: string): GroupedSetting[] {
  const capability = resolveAssetCapability(category, type);
  if (!capability) {
    return [];
  }
  return SETTING_KEYS.filter((key) => capability.settings[key] !== "unsupported").map((key) => ({
    key,
    setting: ADVANCED_SETTINGS[key],
    availability: capability.settings[key],
  }));
}

// The version stamped onto advanced-settings; bump if selection shape changes.
export const ADVANCED_SETTINGS_VERSION = 1;

export type SettingRejectionReason = "unknown" | "unsupported";

export interface SettingValidationError {
  settingKey: string;
  reason: SettingRejectionReason;
}

export function validateSelectedSettings(
  category: AssetCategory,
  type: string,
  settingKeys: readonly string[]
): SettingValidationError[] {
  const errors: SettingValidationError[] = [];
  for (const key of settingKeys) {
    if (!(key in ADVANCED_SETTINGS)) {
      errors.push({ settingKey: key, reason: "unknown" });
    } else if (!isSettingAllowed(category, type, key)) {
      errors.push({ settingKey: key, reason: "unsupported" });
    }
  }
  return errors;
}

export type ParamRejectionReason =
  | "missing"
  | "not_a_number"
  | "below_min"
  | "above_max"
  | "invalid_option"
  | "invalid_format";

export interface ParamValidationError {
  settingKey: string;
  paramKey: string;
  reason: ParamRejectionReason;
  // Violated bound (min/max); omitted for non-range reasons.
  limit?: number;
}

// Coerce to finite number; return null to let caller reject (not silently default).
// Rejects NaN, ±Infinity, and string forms like "Infinity" before post-deploy immutable fields.
function coerceParamNumber(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

// Largest unsigned 64-bit integer — ceiling for u64-format params (e.g. transfer-fee maxFee).
const U64_MAX = 18_446_744_073_709_551_615n;
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Whether a string-kind param satisfies its declared on-chain format. Without this,
// arbitrary strings pass every server check and fail opaquely at the Solana layer.
function matchesStringFormat(
  format: NonNullable<ParamFieldSpec["format"]>,
  value: string
): boolean {
  switch (format) {
    case "u64":
      // Base-10 digits only (rejects signs, decimals, "Infinity", 1e9) within u64 range.
      return /^\d+$/.test(value) && BigInt(value) <= U64_MAX;
    case "base58-pubkey":
      return BASE58_PUBKEY.test(value);
  }
}

// Check param against bounds/format; undefined skipped (presence is editor/resolver's concern).
function checkParamValue(
  spec: ParamFieldSpec,
  value: string | number
): { reason: ParamRejectionReason; limit?: number } | null {
  if (spec.kind === "number") {
    const n = coerceParamNumber(value);
    if (n === null) {
      return { reason: "not_a_number" };
    }
    if (spec.min !== undefined && (spec.exclusiveMin ? n <= spec.min : n < spec.min)) {
      return { reason: "below_min", limit: spec.min };
    }
    if (spec.max !== undefined && n > spec.max) {
      return { reason: "above_max", limit: spec.max };
    }
    return null;
  }
  if (spec.kind === "select") {
    const allowed = spec.options?.some((option) => option.value === value) ?? false;
    return allowed ? null : { reason: "invalid_option" };
  }
  if (spec.kind === "string" && spec.format) {
    const asString = typeof value === "number" ? String(value) : value;
    return matchesStringFormat(spec.format, asString) ? null : { reason: "invalid_format" };
  }
  return null;
}

// Validate param values; server-side gate for expert overrides that bypass client bounds.
// Unknown settings skipped (key-level check handles them); presence is editor/resolver's concern.
export function validateSettingParams(
  selected: Record<string, SelectedSetting>
): ParamValidationError[] {
  const errors: ParamValidationError[] = [];
  for (const [settingKey, selection] of Object.entries(selected)) {
    if (!(settingKey in ADVANCED_SETTINGS)) {
      continue;
    }
    const setting: AdvancedSetting = ADVANCED_SETTINGS[settingKey as SettingKey];
    const specs = setting.params ?? [];
    const params = selection?.params ?? {};
    for (const spec of specs) {
      const value = params[spec.key];
      // Absent/blank required param is rejected; optional param skips bounds.
      if (value === undefined || (typeof value === "string" && value.trim() === "")) {
        if (spec.required) {
          errors.push({ settingKey, paramKey: spec.key, reason: "missing" });
        }
        continue;
      }
      const violation = checkParamValue(spec, value);
      if (violation) {
        errors.push({ settingKey, paramKey: spec.key, ...violation });
      }
    }
  }
  return errors;
}

// Dev-time assertion: registry consistency (every ASSET_TYPES pair, all settings, locked coverage).
if (process.env.NODE_ENV !== "production") {
  const seen = new Set<string>();

  for (const capability of ASSET_CAPABILITIES) {
    const pairKey = `${capability.category}/${capability.type}`;

    if (seen.has(pairKey)) {
      throw new Error(`capabilities: duplicate capability entry for (${pairKey}).`);
    }
    seen.add(pairKey);

    const template = TEMPLATE_DEFINITIONS[normalizeTemplateId(capability.baseTemplate)];
    const incompatible = new Set(template.extensions.incompatible);
    const buildable = new Set([...template.extensions.required, ...template.extensions.available]);
    const lockedExtensions = new Set<string>();

    for (const [settingKey, availability] of Object.entries(capability.settings)) {
      const setting = ADVANCED_SETTINGS[settingKey as SettingKey];
      if (!setting) {
        throw new Error(
          `capabilities: (${pairKey}) references unknown setting "${settingKey}". ` +
            `Known: ${SETTING_KEYS.join(", ")}`
        );
      }
      if (availability === "unsupported") {
        continue;
      }
      if (availability === "locked") {
        for (const extension of setting.extensions) {
          lockedExtensions.add(extension);
        }
      }
      for (const extension of setting.extensions) {
        if (incompatible.has(extension) || !buildable.has(extension)) {
          throw new Error(
            `capabilities: (${pairKey}) marks "${settingKey}" ${availability}, but its ` +
              `extension "${extension}" is not buildable by the ${capability.baseTemplate} ` +
              `template (allowed: ${[...buildable].join(", ") || "none"}).`
          );
        }
      }
    }

    for (const required of template.extensions.required) {
      if (!lockedExtensions.has(required)) {
        throw new Error(
          `capabilities: (${pairKey}) deploys as ${capability.baseTemplate}, which forces ` +
            `"${required}", but no locked setting covers it — it would render as a ` +
            `deselectable box with no on-chain effect. Mark the covering setting "locked".`
        );
      }
    }
  }

  for (const category of Object.keys(ASSET_TYPES) as AssetCategory[]) {
    for (const type of ASSET_TYPES[category]) {
      if (!resolveAssetCapability(category, type)) {
        throw new Error(
          `capabilities: (${category}/${type}) is in ASSET_TYPES but has no capability entry.`
        );
      }
    }
  }
}
