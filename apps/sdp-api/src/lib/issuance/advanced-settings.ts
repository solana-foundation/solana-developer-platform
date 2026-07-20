// Server handling of advanced-settings in issuance_metadata.settings:
// - Validates selections against asset type capabilities
// - Stamps the server version
// Safe to import @sdp/issuance/capabilities here (mosaic-free).

import {
  ADVANCED_SETTINGS_VERSION,
  resolveSettingsToExtensions,
  type SettingValidationError,
  type TemplateOverrideError,
  validateSelectedSettings,
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
): SettingValidationError[] {
  const settings = readSettings(metadata);
  if (!settings?.selected) {
    return [];
  }
  return validateSelectedSettings(category, type, Object.keys(settings.selected));
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
