// Per-asset-type capability registry: setting availability by (category, type).
// Regulated types use guarded templates (fixed extension sets), generics use custom.
// See docs/decisions/0002-asset-advanced-settings.md.

import type { AssetCapability, SettingAvailability } from "@sdp/types";
import { SETTING_KEYS, type SettingKey } from "./settings";

// Build availability map from partial override; unlisted default to "available".
function settings(
  overrides: Partial<Record<SettingKey, SettingAvailability>>
): Record<SettingKey, SettingAvailability> {
  const result = {} as Record<SettingKey, SettingAvailability>;
  for (const key of SETTING_KEYS) {
    result[key] = overrides[key] ?? "available";
  }
  return result;
}

const STABLECOIN_SETTINGS = settings({
  freezeTransfers: "locked",
  permanentDelegate: "locked",
  transferFee: "unsupported",
  interestBearing: "unsupported",
  scaledUiAmount: "unsupported",
  nonTransferable: "unsupported",
  transferHook: "unsupported",
});

const SECURITY_SETTINGS = settings({
  freezeTransfers: "locked",
  permanentDelegate: "locked",
  scaledUiAmount: "recommended",
  transferFee: "unsupported",
  interestBearing: "unsupported",
  nonTransferable: "unsupported",
  transferHook: "unsupported",
});

const GENERIC_SETTINGS = settings({});

export const ASSET_CAPABILITIES: readonly AssetCapability[] = [
  { category: "generic", type: "generic", baseTemplate: "custom", settings: GENERIC_SETTINGS },
  { category: "generic", type: "commodity", baseTemplate: "custom", settings: GENERIC_SETTINGS },
  { category: "generic", type: "real_estate", baseTemplate: "custom", settings: GENERIC_SETTINGS },
  { category: "generic", type: "collectible", baseTemplate: "custom", settings: GENERIC_SETTINGS },

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
