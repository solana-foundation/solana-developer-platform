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
import { normalizeTemplateId, TEMPLATE_DEFINITIONS } from "../templates/definitions";
import { ASSET_CAPABILITIES } from "./capabilities";
import { ADVANCED_SETTINGS, SETTING_KEYS, type SettingKey } from "./settings";

export type { SettingKey };
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

// --- Dev-time completeness assertion ---------------------------------------
//
// Fail fast in development if the registry drifts. Mirrors the guard in
// apps/sdp-web/.../asset-taxonomy.ts. Guarantees:
//   1. every ASSET_TYPES pair has exactly one capability entry;
//   2. every setting an entry references exists in the catalog;
//   3. no recommended/available setting names an extension the entry's
//      baseTemplate lists as `incompatible`.
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
        if (incompatible.has(extension)) {
          throw new Error(
            `capabilities: (${pairKey}) marks "${settingKey}" ${availability}, but its ` +
              `extension "${extension}" is incompatible with the ${capability.baseTemplate} template.`
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
