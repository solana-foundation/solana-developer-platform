// Server handling of advanced-settings in issuance_metadata.settings:
// - Validates selections against asset type capabilities
// - Stamps the server version
// Safe to import @sdp/issuance/capabilities here (mosaic-free).

import {
  ADVANCED_SETTINGS_VERSION,
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

export function getSelectedSettings(metadata: Metadata): Record<string, SelectedSetting> {
  const settings = readSettings(metadata);
  return (settings?.selected as Record<string, SelectedSetting> | undefined) ?? {};
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
  const selected = settings.selected as Record<string, SelectedSetting>;
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
