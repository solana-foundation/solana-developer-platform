// Advanced Settings catalog: manager-facing settings → Token-2022 extensions.
// CODE not table (no migrations). i18n keys in dashboard-issuance.json under `config`.
// See docs/decisions/0002-asset-advanced-settings.md.

import type { AdvancedSetting, TokenExtensionName } from "@sdp/types";

const config = (leaf: string): string => `DashboardIssuance.config.${leaf}`;
const desc = (leaf: string): string => config(`${leaf}Description`);

export const ADVANCED_SETTINGS = {
  freezeTransfers: {
    group: "compliance",
    labelKey: config("freezeTransfers"),
    descriptionKey: desc("freezeTransfers"),
    extensions: ["pausable"],
    actions: ["pause", "unpause", "freeze", "unfreeze"],
    signing: "custodial-or-wallet",
  },
  permanentDelegate: {
    group: "controls",
    labelKey: config("permanentDelegate"),
    descriptionKey: desc("permanentDelegate"),
    extensions: ["permanentDelegate"],
    actions: ["seize", "force_burn"],
    signing: "custodial-or-wallet",
  },
  transferFee: {
    group: "economics",
    labelKey: config("transferFee"),
    descriptionKey: desc("transferFee"),
    extensions: ["transferFee"],
    actions: ["update_authority"],
    signing: "custodial-or-wallet",
    params: [
      {
        key: "basisPoints",
        kind: "number",
        labelKey: config("transferFeeBasisPoints"),
        hintKey: config("transferFeeBasisPointsHint"),
        min: 0,
        max: 10_000,
        required: true,
      },
      {
        key: "maxFee",
        kind: "string",
        format: "u64",
        labelKey: config("transferFeeMaxFee"),
        defaultValue: "0",
      },
    ],
  },
  interestBearing: {
    group: "economics",
    labelKey: config("interestBearing"),
    descriptionKey: desc("interestBearing"),
    extensions: ["interestBearing"],
    actions: ["update_authority"],
    signing: "custodial-or-wallet",
    params: [
      {
        key: "rate",
        kind: "number",
        labelKey: config("interestBearingRate"),
        hintKey: config("interestBearingRateHint"),
        // On-chain i16 basis-points value; valid range is full signed-16-bit span.
        // Negative rates are valid (demurrage); bounds reject pre-deploy overflow.
        min: -32_768,
        max: 32_767,
        required: true,
      },
    ],
  },
  scaledUiAmount: {
    group: "economics",
    labelKey: config("scaledUiAmount"),
    descriptionKey: desc("scaledUiAmount"),
    extensions: ["scaledUiAmount"],
    actions: ["update_authority"],
    signing: "custodial-or-wallet",
    params: [
      {
        key: "multiplier",
        kind: "number",
        // biome-ignore lint/security/noSecrets: i18n message key, not a secret.
        labelKey: config("scaledUiAmountMultiplier"),
        defaultValue: 1,
        // On-chain f64 scaling; must be strictly positive (0 would zero balances).
        // Bound to (0, ∞) exclusive at 0.
        min: 0,
        exclusiveMin: true,
      },
    ],
  },
  nonTransferable: {
    group: "controls",
    labelKey: config("nonTransferable"),
    descriptionKey: desc("nonTransferable"),
    extensions: ["nonTransferable"],
    actions: [],
    signing: "custodial-only",
  },
  transferHook: {
    group: "controls",
    labelKey: config("transferHook"),
    descriptionKey: desc("transferHook"),
    extensions: ["transferHook"],
    actions: ["update_authority"],
    signing: "custodial-or-wallet",
    params: [
      {
        key: "programId",
        kind: "string",
        format: "base58-pubkey",
        labelKey: config("transferHookProgramId"),
        required: true,
      },
    ],
  },
} as const satisfies Record<string, AdvancedSetting>;

// The stable key of a catalog setting. Used everywhere a setting is referenced.
export type SettingKey = keyof typeof ADVANCED_SETTINGS;

export const SETTING_KEYS = Object.keys(ADVANCED_SETTINGS) as SettingKey[];

// Extension pairs that can't coexist: interestBearing+scaledUiAmount (on-chain),
// or nonTransferable+{transferFee,transferHook} (logical conflicts).
export const INCOMPATIBLE_EXTENSION_PAIRS: readonly (readonly [
  TokenExtensionName,
  TokenExtensionName,
])[] = [
  ["interestBearing", "scaledUiAmount"],
  ["nonTransferable", "transferFee"],
  ["nonTransferable", "transferHook"],
];

export function findIncompatibleExtensionPair(
  extensions: Iterable<TokenExtensionName>
): readonly [TokenExtensionName, TokenExtensionName] | null {
  const present = new Set(extensions);
  for (const pair of INCOMPATIBLE_EXTENSION_PAIRS) {
    if (present.has(pair[0]) && present.has(pair[1])) {
      return pair;
    }
  }
  return null;
}
