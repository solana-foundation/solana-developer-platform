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
import {
  ADVANCED_SETTINGS,
  INCOMPATIBLE_EXTENSION_PAIRS,
  SETTING_KEYS,
  type SettingKey,
} from "./settings";

export {
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

// Drop settings that would form an incompatible extension pair, keeping the
// earlier-listed one; unknown keys are dropped too. Order-preserving. Used to
// sanitise a persisted selection on load, so stale storage can't restore a
// conflicting combination the editor would never let you build interactively.
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

// Setting keys whose extension clashes with `settingKey`'s — the two cannot be
// enabled together on one token. Drives the editor's conflict disabling. Derived
// from INCOMPATIBLE_EXTENSION_PAIRS by mapping each conflicting extension back to
// the setting(s) that configure it.
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

// The capability entry for an asset type, or undefined for an unknown pair.
export function resolveAssetCapability(
  category: AssetCategory,
  type: string
): AssetCapability | undefined {
  return ASSET_CAPABILITIES.find((c) => c.category === category && c.type === type);
}

// Settings that default ON for an asset type — the pre-checked selection.
// Includes both `locked` (forced on) and `recommended` (default on, deselectable)
// settings; the caller pre-fills these with their default params.
export function getRecommendedSettings(category: AssetCategory, type: string): SettingKey[] {
  const capability = resolveAssetCapability(category, type);
  if (!capability) {
    return [];
  }
  return SETTING_KEYS.filter(
    (key) => capability.settings[key] === "recommended" || capability.settings[key] === "locked"
  );
}

// Settings an asset type forces on and does not let the manager deselect. The
// editor renders these checked-and-disabled; persistence keeps them selected.
export function getLockedSettings(category: AssetCategory, type: string): SettingKey[] {
  const capability = resolveAssetCapability(category, type);
  if (!capability) {
    return [];
  }
  return SETTING_KEYS.filter((key) => capability.settings[key] === "locked");
}

// Whether an asset type permits a setting at all (locked, recommended, or
// available). The single gate the persistence/validation layer (C) calls to
// reject an unsupported selection early.
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
    availability === "locked" ||
    availability === "recommended" ||
    availability === "available"
  );
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
//   3. every locked/recommended/available setting names only extensions the
//      entry's baseTemplate can actually build — i.e. present in
//      `required ∪ available` and not in `incompatible`. This mirrors
//      resolveTemplateConfig's own override check, so a selection the capability
//      offers can never be one the resolver would reject at deploy.
//   4. every extension the baseTemplate lists as `required` (the guarded builder
//      forces it on unconditionally) is covered by a `locked` setting — so a
//      forced extension can never be surfaced as an optional, deselectable box
//      whose unticking has no on-chain effect.
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

    // (4) Every template-required extension must be locked, not merely offered.
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
