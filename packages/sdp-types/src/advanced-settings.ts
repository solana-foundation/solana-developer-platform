// Advanced Settings: the manager-facing "advanced" token configuration layer
// that sits on top of an Asset Profile (see asset-profiles.ts) and, at deploy,
// drives the on-chain Token-2022 extension config.
//
// This file holds SHAPES ONLY. The concrete catalog data, the per-asset-type
// capability registry, the lookups, and the settings->extension resolver live
// in @sdp/issuance/capabilities — the package that is allowed to import both
// these shapes and the template resolver (resolveTemplateConfig). Placing the
// logic here instead would force @sdp/types to import @sdp/issuance, which
// already imports @sdp/types, i.e. a dependency cycle. Shapes stay in the leaf;
// logic lives where its dependencies are.
//
// See docs/decisions/0002-asset-advanced-settings.md.

import type { AssetCategory } from "./asset-profiles";
import type { TokenExtensionName, TokenTemplate, TokenTransactionType } from "./tokens";

// Whether a setting is on by default, opt-in, or forbidden for an asset type.
export type SettingAvailability = "recommended" | "available" | "unsupported";

// Who signs the transaction that realizes a setting. "custodial-or-wallet"
// means the platform's custody wallet signs by default and the manager can fall
// back to signing in their own wallet extension when no custody wallet holds the
// required authority; "custodial-only" has no self-sign fallback.
export type SettingSigning = "custodial-only" | "custodial-or-wallet";

// Manager-friendly grouping used by the settings editor UI (ticket E). The
// catalog is the single source of grouping so the UI never hardcodes it.
export type SettingGroup = "economics" | "compliance" | "controls";

// Descriptor for one expert-override parameter of a setting (e.g. transfer-fee
// basis points). B declares the descriptor so the editor (E) can render the
// field and persistence (C) can attach runtime validation; the app-level
// per-extension zod is not importable from a package, so it is wired in C.
export interface ParamFieldSpec {
  key: string;
  kind: "number" | "string" | "select";
  labelKey: string;
  defaultValue?: string | number;
  options?: readonly { value: string; labelKey: string }[];
  min?: number;
  max?: number;
}

// One manager-facing advanced setting: its plain-language copy, the Token-2022
// extension(s) it configures (an internal detail — never rendered raw), the SDP
// actions it unlocks, its signing/fallback story, and optional expert params.
export interface AdvancedSetting {
  group: SettingGroup;
  // i18n MessageKeys. The copy describes EFFECTS ("Freeze tokens in response to
  // compliance events"), never mechanics ("enables the pausable extension").
  labelKey: string;
  descriptionKey: string;
  extensions: readonly TokenExtensionName[];
  actions: readonly TokenTransactionType[];
  signing: SettingSigning;
  // Absent ⇒ a plain on/off toggle. Present ⇒ the setting exposes expert fields.
  params?: readonly ParamFieldSpec[];
}

// Per-(category, type) capability declaration: which template it deploys as, and
// which settings it recommends / allows / forbids. Composed à la carte rather
// than pinned to a fixed template — `baseTemplate` is only the deploy substrate.
export interface AssetCapability {
  category: AssetCategory;
  type: string;
  baseTemplate: TokenTemplate;
  // Keyed by settingKey. The keys are validated against the catalog by a
  // dev-time completeness assertion in @sdp/issuance/capabilities.
  settings: Record<string, SettingAvailability>;
}

// --- Stored selection (persistence, ticket C) ------------------------------

// One selected setting. Presence of the key in `StoredAdvancedSettings.selected`
// means the setting is enabled; `params` carries the expert-override values for
// parametric settings (validated against the catalog's ParamFieldSpec).
export interface SelectedSetting {
  params?: Record<string, string | number>;
}

// The manager's advanced-settings selection as persisted under
// `issuance_metadata.settings`. `version` is server-stamped
// (ADVANCED_SETTINGS_VERSION); clients need not send it.
export interface StoredAdvancedSettings {
  version: number;
  selected: Record<string, SelectedSetting>;
}
