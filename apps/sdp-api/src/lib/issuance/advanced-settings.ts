// Server-side handling of the advanced-settings selection stored under
// `issuance_metadata.settings` (persistence, ticket C).
//
// Two concerns the Zod schema can't cover on its own:
//   - validation of each selected setting against the asset type's capability
//     (needs the effective category/type), and
//   - stamping the server-owned settings version.
//
// The catalog + capability lookups live in the mosaic-free
// @sdp/issuance/capabilities subpath, so importing them here is safe in the
// Workers runtime.

import {
  ADVANCED_SETTINGS_VERSION,
  resolveSettingsToExtensions,
  type SettingValidationError,
  type TemplateOverrideError,
  validateSelectedSettings,
} from "@sdp/issuance/capabilities";
import type { AssetCategory, IssuanceMetadata, SelectedSetting } from "@sdp/types";

// The loose issuance-metadata object the settings namespace lives inside. Using
// IssuanceMetadata (rather than a bare Record) keeps the stamped result
// assignable at the repository boundary.
type Metadata = IssuanceMetadata;

interface SettingsNamespace {
  version?: number;
  selected?: Record<string, unknown>;
}

// Read the `settings` namespace defensively (metadata is loosely typed JSONB).
function readSettings(metadata: Metadata): SettingsNamespace | undefined {
  const settings = metadata.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return undefined;
  }
  return settings as SettingsNamespace;
}

// The selected settings map (settingKey → selection), or {} when absent. Used at
// token create to drive the token's extension config from the profile.
export function getSelectedSettings(metadata: Metadata): Record<string, SelectedSetting> {
  const settings = readSettings(metadata);
  return (settings?.selected as Record<string, SelectedSetting> | undefined) ?? {};
}

// Validate the selected settings in `metadata` against the (category, type)
// capability. Empty result ⇒ nothing selected, or every selection is allowed.
export function validateAdvancedSettings(
  category: AssetCategory,
  type: string,
  metadata: Metadata
): SettingValidationError[] {
  const settings = readSettings(metadata);
  if (!settings?.selected) {
    return [];
  }
  return validateSelectedSettings(category, type, Object.keys(settings.selected));
}

// Resolve the selected settings into a token extension config and return any
// template-level build errors — the resolver-driven half of "flag unsupported
// combinations early". The dev-time assertion keeps the capability registry
// consistent with the templates, but that assertion is skipped in production, so
// this runtime check is the production safety net against a selection the deploy
// resolver couldn't build. Empty result ⇒ nothing selected, or it builds cleanly.
export function resolveAdvancedSettings(
  category: AssetCategory,
  type: string,
  metadata: Metadata
): TemplateOverrideError[] {
  const settings = readSettings(metadata);
  if (!settings?.selected) {
    return [];
  }
  const { errors } = resolveSettingsToExtensions(
    category,
    type,
    settings.selected as Record<string, SelectedSetting>
  );
  return errors;
}

// Return metadata with the settings version stamped to the current server
// version. No-op when there is no settings selection. Never mutates the input;
// generic so the caller's metadata type is preserved across the repo boundary.
export function stampAdvancedSettingsVersion<T extends Metadata>(metadata: T): T {
  const settings = readSettings(metadata);
  if (!settings?.selected) {
    return metadata;
  }
  return {
    ...metadata,
    settings: { ...settings, version: ADVANCED_SETTINGS_VERSION },
  } as T;
}
