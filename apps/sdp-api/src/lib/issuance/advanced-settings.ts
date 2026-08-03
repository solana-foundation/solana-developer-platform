// Server handling of advanced-settings in issuance_metadata.settings:
// - Validates selections against asset type capabilities
// - Stamps the server version
// Safe to import @sdp/issuance/capabilities here (mosaic-free).

import {
  ADVANCED_SETTINGS_VERSION,
  AUTHORITY_VALUED_SETTINGS,
  expandLegacySettingKeys,
  type ParamValidationError,
  resolveSettingsToExtensions,
  type SettingValidationError,
  type TemplateOverrideError,
  validateSelectedSettings,
  validateSettingParams,
} from "@sdp/issuance/capabilities";
import type { AssetCategory, IssuanceMetadata, SelectedSetting } from "@sdp/types";

type Metadata = IssuanceMetadata;

interface SettingsNamespace {
  version?: number;
  selected?: Record<string, unknown>;
}

function readSettings(metadata: Metadata): SettingsNamespace | undefined {
  const settings = metadata.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return undefined;
  }
  return settings as SettingsNamespace;
}

/**
 * The stored selection, with retired setting keys rewritten to their current
 * equivalents. Every server read goes through here so a profile persisted before
 * a catalog split keeps working — otherwise validation would reject the old key
 * as "unknown" and the resolver would silently skip it.
 */
export function getSelectedSettings(metadata: Metadata): Record<string, SelectedSetting> {
  const settings = readSettings(metadata);
  const selected = (settings?.selected as Record<string, SelectedSetting> | undefined) ?? {};
  return expandLegacySettingKeys(selected);
}

export function selectedAuthorityValuedSettings(metadata: Metadata): string[] {
  const selected = getSelectedSettings(metadata);
  return AUTHORITY_VALUED_SETTINGS.filter((key) => key in selected);
}

export function validateAdvancedSettings(
  category: AssetCategory,
  type: string,
  metadata: Metadata
): (SettingValidationError | ParamValidationError)[] {
  const settings = readSettings(metadata);
  if (!settings?.selected) {
    return [];
  }
  // Expanded, so a caller sending a retired key is normalized rather than told
  // its key is unknown.
  const selected = getSelectedSettings(metadata);
  const keyErrors = validateSelectedSettings(category, type, Object.keys(selected));
  // Range-check only the params of settings that passed the key check: an unknown
  // or unsupported setting is already reported, so re-flagging its params is noise.
  const rejected = new Set(keyErrors.map((error) => error.settingKey));
  const checkable = Object.fromEntries(
    Object.entries(selected).filter(([key]) => !rejected.has(key))
  );
  return [...keyErrors, ...validateSettingParams(checkable)];
}

// Resolve settings to extension config; returns build errors if any.
// This is the production safety net (dev assertion is skipped in prod).
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
