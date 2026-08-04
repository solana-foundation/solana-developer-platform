// Advanced Settings catalog: manager-facing settings → Token-2022 extensions.
// CODE not table (no migrations). i18n keys in dashboard-issuance.json under `config`.
// See docs/decisions/0002-asset-advanced-settings.md.

import type { AdvancedSetting, TokenExtensionName } from "@sdp/types";

const config = (leaf: string): string => `DashboardIssuance.config.${leaf}`;
const desc = (leaf: string): string => config(`${leaf}Description`);

export const ADVANCED_SETTINGS = {
  // Pausing the whole mint and freezing individual accounts are two different
  // on-chain mechanisms, so they are two settings:
  //
  //   pauseTransfers → the Token-2022 `pausable` extension (mint-level).
  //   freezeAccounts → the BASE mint's freeze authority (a COption<Pubkey> field
  //                    on the Mint account, present on plain SPL Token too). It
  //                    therefore declares no extensions and resolves to the
  //                    token's `isFreezable` column, the same way the allowlist
  //                    setting resolves to `requiresAllowlist`.
  //
  // They were previously a single "freezeTransfers" entry that claimed `pausable`
  // as its extension while also declaring freeze/unfreeze — advertising a
  // capability its extension does not provide. The basic (non-technical) editor
  // still presents them as one combined row; the technical view shows both.
  // `LEGACY_SETTING_ALIASES` below keeps stored "freezeTransfers" selections
  // readable.
  pauseTransfers: {
    group: "compliance",
    labelKey: config("pauseTransfers"),
    descriptionKey: desc("pauseTransfers"),
    extensions: ["pausable"],
    actions: ["pause", "unpause"],
  },
  freezeAccounts: {
    group: "compliance",
    labelKey: config("freezeAccounts"),
    descriptionKey: desc("freezeAccounts"),
    extensions: [],
    actions: ["freeze", "unfreeze"],
  },
  permanentDelegate: {
    group: "controls",
    labelKey: config("permanentDelegate"),
    descriptionKey: desc("permanentDelegate"),
    extensions: ["permanentDelegate"],
    actions: ["seize", "force_burn"],
  },
  transferFee: {
    group: "economics",
    labelKey: config("transferFee"),
    descriptionKey: desc("transferFee"),
    extensions: ["transferFee"],
    actions: ["update_authority"],
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
  transferHook: {
    group: "controls",
    labelKey: config("transferHook"),
    descriptionKey: desc("transferHook"),
    extensions: ["transferHook"],
    actions: ["update_authority"],
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
  // nonTransferable is a terminal "opt out of transfers" choice — kept last so the
  // list ends on it (it conflicts with the transfer-related settings above).
  nonTransferable: {
    group: "controls",
    labelKey: config("nonTransferable"),
    descriptionKey: desc("nonTransferable"),
    extensions: ["nonTransferable"],
    actions: [],
  },
} as const satisfies Record<string, AdvancedSetting>;

// The stable key of a catalog setting. Used everywhere a setting is referenced.
export type SettingKey = keyof typeof ADVANCED_SETTINGS;

export const SETTING_KEYS = Object.keys(ADVANCED_SETTINGS) as SettingKey[];

/**
 * Retired setting keys and the current keys they expand to.
 *
 * Selections persist in `issuance_metadata.settings.selected` and in the wizard's
 * localStorage draft, and every hydration path prunes keys that are not in
 * ADVANCED_SETTINGS. Without this map a stored "freezeTransfers" would be dropped
 * silently — and invisibly for stablecoins/securities, where the replacement keys
 * are "locked" and get re-added anyway.
 *
 * Read-only: nothing writes a legacy key back.
 */
export const LEGACY_SETTING_ALIASES: Readonly<Record<string, readonly SettingKey[]>> = {
  freezeTransfers: ["pauseTransfers", "freezeAccounts"],
};

/**
 * Rewrite any retired keys in a stored selection to their current equivalents,
 * preserving each alias target's params and never clobbering a key that the
 * payload already sets explicitly.
 */
export function expandLegacySettingKeys<T>(
  selected: Readonly<Record<string, T>>
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(selected)) {
    const targets = LEGACY_SETTING_ALIASES[key];
    if (!targets) {
      result[key] = value;
      continue;
    }
    for (const target of targets) {
      if (!(target in selected)) {
        result[target] = value;
      }
    }
  }
  return result;
}

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
