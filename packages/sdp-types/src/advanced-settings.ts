// Manager-facing token configuration layer on top of Asset Profiles, drives on-chain Token-2022 extension config.
// SHAPES ONLY — logic lives in @sdp/issuance/capabilities to avoid circular dependency (@sdp/types imports @sdp/issuance, which imports @sdp/types).
// See docs/decisions/0002-asset-advanced-settings.md.

import type { AssetCategory } from "./asset-profiles";
import type { TokenExtensionName, TokenTemplate, TokenTransactionType } from "./tokens";

// "locked" = enforced by base template (checked-disabled UI); others = opt-in/default/forbidden.
export type SettingAvailability = "locked" | "recommended" | "available" | "unsupported";

// UI grouping — sourced from catalog, never hardcoded in editor.
export type SettingGroup = "economics" | "compliance" | "controls";

// Expert-override parameter descriptor (e.g., transfer-fee basis points). Wired to editor UI and server validation.
export interface ParamFieldSpec {
  key: string;
  kind: "number" | "string" | "select";
  labelKey: string;
  defaultValue?: string | number;
  options?: readonly { value: string; labelKey: string }[];
  // Server-side validation format: "u64" = base-10 uint64; "base58-pubkey" = Solana address. Pre-flight to turn deploy errors into 400s.
  format?: "u64" | "base58-pubkey";
  min?: number;
  max?: number;
  // When true, min is strict (> not >=); for factors that must be positive with no inclusive floor.
  exclusiveMin?: boolean;
  // When true, editor marks it and wizard blocks Continue until filled.
  required?: boolean;
  // Manager-facing helper under field (Basic/Detailed); Expert mode shows technical spec instead.
  hintKey?: string;
}

// Manager-facing setting: copy, Token-2022 extensions (internal), SDP actions, optional expert params.
export interface AdvancedSetting {
  group: SettingGroup;
  // Copy describes effects, never mechanics (e.g., "Freeze tokens" not "enable pausable extension").
  labelKey: string;
  descriptionKey: string;
  extensions: readonly TokenExtensionName[];
  actions: readonly TokenTransactionType[];
  // Absent = plain toggle; present = exposes expert fields.
  params?: readonly ParamFieldSpec[];
}

// Per-(category, type) declaration: deploy template and per-setting availability (à la carte, not pinned).
export interface AssetCapability {
  category: AssetCategory;
  type: string;
  baseTemplate: TokenTemplate;
  // Keys validated against catalog at dev-time.
  settings: Record<string, SettingAvailability>;
}

// --- Stored selection ----

// Selected setting: presence in StoredAdvancedSettings.selected means enabled.
export interface SelectedSetting {
  params?: Record<string, string | number>;
}

// Persisted under issuance_metadata.settings; version server-stamped, clients omit.
export interface StoredAdvancedSettings {
  version: number;
  selected: Record<string, SelectedSetting>;
}
