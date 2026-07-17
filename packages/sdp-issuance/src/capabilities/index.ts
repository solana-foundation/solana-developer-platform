// @sdp/issuance/capabilities
//
// The Advanced Settings capability foundation (ticket B): the manager-facing
// setting catalog, the per-asset-type capability registry, and the pure lookups
// over them. Importable without @solana/mosaic-sdk (this module touches only
// @sdp/types and ./templates/definitions), so the API, web, and tests can use it
// freely. The settings->extension resolver (ticket A), persistence/validation
// (C), and UI (D/E) build on top of what this module exports.

import type {
  AdvancedSetting,
  AssetCapability,
  AssetCategory,
  SettingAvailability,
} from "@sdp/types";
import { ASSET_TYPES } from "@sdp/types";
import {
  normalizeTemplateId,
  TEMPLATE_DEFINITIONS,
  type TemplateOverrideError,
} from "../templates/definitions";
import { ASSET_CAPABILITIES } from "./capabilities";
import { ADVANCED_SETTINGS, SETTING_KEYS, type SettingKey } from "./settings";

export {
  type ExtensionAuthorities,
  resolveSettingsToExtensions,
  type SettingsResolution,
} from "./resolver";
export type { SettingKey, TemplateOverrideError };
export { ADVANCED_SETTINGS, ASSET_CAPABILITIES, SETTING_KEYS };

// The capability entry for an asset type, or undefined for an unknown pair.
export function resolveAssetCapability(
  category: AssetCategory,
  type: string
): AssetCapability | undefined {
  return ASSET_CAPABILITIES.find((c) => c.category === category && c.type === type);
}

// Settings that default ON for an asset type (the pre-checked selection).
export function getRecommendedSettings(category: AssetCategory, type: string): SettingKey[] {
  const capability = resolveAssetCapability(category, type);
  if (!capability) {
    return [];
  }
  return SETTING_KEYS.filter((key) => capability.settings[key] === "recommended");
}

// Whether an asset type permits a setting at all (recommended or available).
// The single gate the persistence/validation layer (C) calls to reject an
// unsupported selection early.
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
  return availability === "recommended" || availability === "available";
}

export interface GroupedSetting {
  key: SettingKey;
  setting: AdvancedSetting;
  availability: SettingAvailability;
}

// The settings an asset type can show, dropping `unsupported` ones. The editor
// UI (E) groups these by `setting.group`.
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

// --- Persistence contract --------------------------------------------------

// The version stamped onto a stored advanced-settings payload. Bump when the
// SHAPE of the settings selection changes (independent of asset_type_version,
// which tracks the asset type's metadata shape). Persistence stamps this so a
// stored selection records the schema it was written under.
export const ADVANCED_SETTINGS_VERSION = 1;

export type SettingRejectionReason = "unknown" | "unsupported";

export interface SettingValidationError {
  settingKey: string;
  reason: SettingRejectionReason;
}

// Validate a set of selected setting keys against an asset type's capability.
// "unknown" ⇒ not a catalog setting; "unsupported" ⇒ the type forbids it. An
// empty result means every key is allowed. This is the single gate the API
// calls to reject a bad selection early (persistence ticket C).
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

// --- Dev-time completeness assertion ---------------------------------------
//
// Fail fast in development if the registry drifts. Mirrors the guard in
// apps/sdp-web/.../asset-taxonomy.ts. Guarantees:
//   1. every ASSET_TYPES pair has exactly one capability entry;
//   2. every setting an entry references exists in the catalog;
//   3. every recommended/available setting names only extensions the entry's
//      baseTemplate can actually build — i.e. present in `required ∪ available`
//      and not in `incompatible`. This mirrors resolveTemplateConfig's own
//      override check, so a selection the capability offers can never be one the
//      resolver would reject at deploy.
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
