// The Advanced Settings catalog: the single source of truth mapping each
// manager-facing setting to its Token-2022 extension(s), the SDP actions it
// unlocks, its signing/fallback story, and any expert-override params.
//
// This is CODE, not a table — adding a setting is a change to this file, never a
// migration (mirrors ASSET_TYPE_REGISTRY). i18n keys point at
// apps/sdp-web/messages/en/dashboard-issuance.json under `config`; keys marked
// NEW are added by the manager-names/UI work (tickets D/E), not this step.
//
// See docs/decisions/0002-asset-advanced-settings.md.

import type { AdvancedSetting, TokenExtensionName } from "@sdp/types";

// Build a fully-qualified message key for a `config.*` entry. Keeping the leaf
// as the only literal avoids repeating the namespace on every entry (and keeps
// each string literal short, which the linter's secret heuristic prefers).
const config = (leaf: string): string => `DashboardIssuance.config.${leaf}`;
// The paired description key for a setting whose label uses the same leaf.
const desc = (leaf: string): string => config(`${leaf}Description`);

export const ADVANCED_SETTINGS = {
  // On/off. The pausable extension backs emergency freezes. (defaultAccountState
  // is template-managed via the allowlist setting, not configured here.) Reuses
  // existing i18n keys.
  freezeTransfers: {
    group: "compliance",
    labelKey: config("freezeTransfers"),
    descriptionKey: desc("freezeTransfers"),
    extensions: ["pausable"],
    actions: ["pause", "unpause", "freeze", "unfreeze"],
    signing: "custodial-or-wallet",
  },
  // Lets a controlled authority seize or force-burn tokens (compliance events).
  permanentDelegate: {
    group: "controls",
    labelKey: config("permanentDelegate"), // NEW
    descriptionKey: desc("permanentDelegate"), // NEW
    extensions: ["permanentDelegate"],
    actions: ["seize", "force_burn"],
    signing: "custodial-or-wallet",
  },
  // Parametric: a percentage fee withheld on every transfer.
  transferFee: {
    group: "economics",
    labelKey: config("transferFee"), // NEW
    descriptionKey: desc("transferFee"), // NEW
    extensions: ["transferFee"],
    actions: ["update_authority"],
    signing: "custodial-or-wallet",
    params: [
      {
        key: "basisPoints",
        kind: "number",
        labelKey: config("transferFeeBasisPoints"), // NEW
        hintKey: config("transferFeeBasisPointsHint"), // NEW
        min: 0,
        max: 10_000,
        required: true,
      },
      {
        key: "maxFee",
        kind: "string",
        labelKey: config("transferFeeMaxFee"), // NEW
        defaultValue: "0",
      },
    ],
  },
  // Parametric: token balance accrues interest at a fixed rate.
  interestBearing: {
    group: "economics",
    labelKey: config("interestBearing"), // NEW
    descriptionKey: desc("interestBearing"), // NEW
    extensions: ["interestBearing"],
    actions: ["update_authority"],
    signing: "custodial-or-wallet",
    params: [
      {
        key: "rate",
        kind: "number",
        labelKey: config("interestBearingRate"), // NEW
        hintKey: config("interestBearingRateHint"), // NEW
        required: true,
      },
    ],
  },
  // Parametric: a UI multiplier applied to displayed balances (e.g. for splits).
  scaledUiAmount: {
    group: "economics",
    labelKey: config("scaledUiAmount"), // NEW
    descriptionKey: desc("scaledUiAmount"), // NEW
    extensions: ["scaledUiAmount"],
    actions: ["update_authority"],
    signing: "custodial-or-wallet",
    params: [
      {
        key: "multiplier",
        kind: "number",
        // biome-ignore lint/security/noSecrets: i18n message key, not a secret.
        labelKey: config("scaledUiAmountMultiplier"), // NEW
        defaultValue: 1,
      },
    ],
  },
  // On/off: tokens can never be transferred once held (soulbound).
  nonTransferable: {
    group: "controls",
    labelKey: config("nonTransferable"), // NEW
    descriptionKey: desc("nonTransferable"), // NEW
    extensions: ["nonTransferable"],
    actions: [],
    signing: "custodial-only",
  },
  // Parametric: route every transfer through a custom on-chain program.
  transferHook: {
    group: "controls",
    labelKey: config("transferHook"), // NEW
    descriptionKey: desc("transferHook"), // NEW
    extensions: ["transferHook"],
    actions: ["update_authority"],
    signing: "custodial-or-wallet",
    params: [
      {
        key: "programId",
        kind: "string",
        labelKey: config("transferHookProgramId"), // NEW
        required: true,
      },
    ],
  },
} as const satisfies Record<string, AdvancedSetting>;

// The stable key of a catalog setting. Used everywhere a setting is referenced.
export type SettingKey = keyof typeof ADVANCED_SETTINGS;

export const SETTING_KEYS = Object.keys(ADVANCED_SETTINGS) as SettingKey[];

// Extension pairs that cannot coexist on a single mint — pairwise and symmetric.
// Unlike a template's `incompatible` list (which says "this extension doesn't
// belong on this template"), these are conflicts *between two extensions*
// regardless of template:
//
//   interestBearing + scaledUiAmount — a hard on-chain conflict: both define the
//     raw→displayed amount conversion, so mint init rejects a mint carrying both.
//   nonTransferable + transferFee / transferHook — logical conflicts: a token
//     that can never transfer has no transfers to charge a fee on or route
//     through a hook, so pairing them is nonsensical. Blocked so the editor
//     can't offer meaningless combinations.
export const INCOMPATIBLE_EXTENSION_PAIRS: readonly (readonly [
  TokenExtensionName,
  TokenExtensionName,
])[] = [
  ["interestBearing", "scaledUiAmount"],
  ["nonTransferable", "transferFee"],
  ["nonTransferable", "transferHook"],
];

// The first incompatible pair fully present in `extensions`, or null if none
// clash. Symmetric — order of the inputs doesn't matter.
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
