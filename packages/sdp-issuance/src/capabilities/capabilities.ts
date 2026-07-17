// The per-asset-type capability registry: one AssetCapability for every
// (category, type) pair in ASSET_TYPES. Declares the deploy substrate and, for
// each catalog setting, whether it is recommended (default on), available
// (opt-in), or unsupported (hidden/rejected).
//
// Regulated types deploy via their guarded Mosaic template, which supports a
// fixed extension set (stablecoin: permanentDelegate + pausable; security: +
// scaledUiAmount). Settings whose extension the guarded template can't build are
// therefore `unsupported` — the dev-time assertion in index.ts enforces that no
// recommended/available setting names an extension outside the template. Generic
// types deploy via the `custom` substrate and compose the full set freely.
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

// Stablecoin template allows only permanentDelegate + pausable, so freeze
// (pausable) and permanentDelegate are recommended and everything else is
// unsupported.
const STABLECOIN_SETTINGS = settings({
  freezeTransfers: "recommended",
  permanentDelegate: "recommended",
  transferFee: "unsupported",
  interestBearing: "unsupported",
  scaledUiAmount: "unsupported",
  nonTransferable: "unsupported",
  transferHook: "unsupported",
});

// Tokenized-security template allows permanentDelegate + pausable + scaledUiAmount.
const SECURITY_SETTINGS = settings({
  freezeTransfers: "recommended",
  permanentDelegate: "recommended",
  scaledUiAmount: "recommended",
  transferFee: "unsupported",
  interestBearing: "unsupported",
  nonTransferable: "unsupported",
  transferHook: "unsupported",
});

// Generic assets deploy via the custom substrate: everything opt-in, nothing forced.
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
    settings: STABLECOIN_SETTINGS,
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
    settings: SECURITY_SETTINGS,
  },
  {
    category: "tokenized_security",
    type: "fund",
    baseTemplate: "tokenized-security",
    settings: SECURITY_SETTINGS,
  },
];
