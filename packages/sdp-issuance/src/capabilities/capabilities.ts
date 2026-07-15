// The per-asset-type capability registry: one AssetCapability for every
// (category, type) pair in ASSET_TYPES. Declares the deploy substrate and, for
// each catalog setting, whether it is recommended (default on), available
// (opt-in), or unsupported (hidden/rejected).
//
// Composed à la carte: generic types use the `custom` substrate for free
// composition; regulated types use their guarded template so the template's
// required extensions are always enforced at deploy regardless of selection.
//
// See docs/decisions/0002-asset-advanced-settings.md.

import type { AssetCapability, SettingAvailability } from "@sdp/types";
import { SETTING_KEYS, type SettingKey } from "./settings";

// Build a complete availability map from a partial override; unlisted settings
// default to "available". Using Record<SettingKey, …> makes the compiler flag
// any setting a type forgot to classify.
function settings(
  overrides: Partial<Record<SettingKey, SettingAvailability>>
): Record<SettingKey, SettingAvailability> {
  const result = {} as Record<SettingKey, SettingAvailability>;
  for (const key of SETTING_KEYS) {
    result[key] = overrides[key] ?? "available";
  }
  return result;
}

// Stablecoins: permanentDelegate + pausable are required by the template, so
// their manager-facing settings are recommended; stablecoins stay transferable.
const STABLECOIN_SETTINGS = settings({
  freezeTransfers: "recommended",
  permanentDelegate: "recommended",
  nonTransferable: "unsupported",
});

// Tokenized securities: as stablecoins, plus scaledUiAmount is template-required.
const SECURITY_SETTINGS = settings({
  freezeTransfers: "recommended",
  permanentDelegate: "recommended",
  scaledUiAmount: "recommended",
  nonTransferable: "unsupported",
});

// Generic assets: everything opt-in, nothing forced.
const GENERIC_SETTINGS = settings({});

export const ASSET_CAPABILITIES: readonly AssetCapability[] = [
  // --- generic (custom substrate, free composition) ------------------------
  { category: "generic", type: "generic", baseTemplate: "custom", settings: GENERIC_SETTINGS },
  { category: "generic", type: "commodity", baseTemplate: "custom", settings: GENERIC_SETTINGS },
  { category: "generic", type: "real_estate", baseTemplate: "custom", settings: GENERIC_SETTINGS },
  { category: "generic", type: "collectible", baseTemplate: "custom", settings: GENERIC_SETTINGS },

  // --- stablecoin (guarded template) ---------------------------------------
  {
    category: "stablecoin",
    type: "fiat_backed",
    baseTemplate: "stablecoin",
    // A fiat peg does not bear yield.
    settings: settings({
      freezeTransfers: "recommended",
      permanentDelegate: "recommended",
      nonTransferable: "unsupported",
      interestBearing: "unsupported",
    }),
  },
  {
    category: "stablecoin",
    type: "crypto_backed",
    baseTemplate: "stablecoin",
    settings: STABLECOIN_SETTINGS,
  },
  {
    category: "stablecoin",
    type: "generic",
    baseTemplate: "stablecoin",
    settings: STABLECOIN_SETTINGS,
  },

  // --- tokenized_security (guarded template) -------------------------------
  {
    category: "tokenized_security",
    type: "generic",
    baseTemplate: "tokenized-security",
    settings: SECURITY_SETTINGS,
  },
  {
    category: "tokenized_security",
    type: "equity",
    baseTemplate: "tokenized-security",
    settings: SECURITY_SETTINGS,
  },
  {
    category: "tokenized_security",
    type: "debt",
    baseTemplate: "tokenized-security",
    // Debt instruments typically accrue interest.
    settings: settings({
      freezeTransfers: "recommended",
      permanentDelegate: "recommended",
      scaledUiAmount: "recommended",
      interestBearing: "recommended",
      nonTransferable: "unsupported",
    }),
  },
  {
    category: "tokenized_security",
    type: "fund",
    baseTemplate: "tokenized-security",
    settings: SECURITY_SETTINGS,
  },
];
