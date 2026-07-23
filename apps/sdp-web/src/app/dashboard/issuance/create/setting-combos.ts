import {
  ADVANCED_SETTINGS,
  INCOMPATIBLE_EXTENSION_PAIRS,
  type SettingKey,
} from "@sdp/issuance/capabilities";
import type { AdvancedSetting, AssetCategory, TokenExtensionName } from "@sdp/types";
import { CAPACITY_META } from "./asset-details-config";
import type {
  AccessControlMode,
  AdvancedSettingsDraft,
  CapacityKey,
  CapacitySelection,
} from "./issuance-draft-wizard.types";

// Basic-mode preset: curated bundle of optional settings + capacities.
// Enables underlying settings shown in Detailed/Expert; multiple combos' settings union.
export interface SettingCombo {
  key: string;
  category: AssetCategory;
  labelKey: string;
  descriptionKey: string;
  settings: readonly SettingKey[];
  capacities: readonly CapacityKey[];
  // The access-control mode this preset implies (e.g. "allowlist" for a
  // verified-holder scenario). Undefined = the preset leaves access control alone.
  // Kept separate from `settings` — accessControl is its own draft field, not a
  // catalog extension. Several combos may share a mode (a richer scenario nests a
  // simpler one); removeCombo's cascade keeps them coherently deselectable.
  accessControl?: AccessControlMode;
}

const cfg = (leaf: string): string => `DashboardIssuance.config.${leaf}`;

export const SETTING_COMBOS: readonly SettingCombo[] = [
  {
    key: "regulatedStablecoin",
    category: "stablecoin",
    labelKey: cfg("comboRegulatedStablecoin"),
    descriptionKey: cfg("comboRegulatedStablecoinDescription"),
    settings: [],
    capacities: ["kyc", "issueRetireControls", "redemptionApprovals", "investorReporting"],
    // A public fiat-backed coin is open to everyone except sanctioned wallets — a
    // blocklist (freeze known-bad addresses), not an allowlist. This is the model
    // for USDC/USDT-style coins and matches the stablecoin template default.
    accessControl: "blocklist",
  },
  {
    key: "permissionedStablecoin",
    category: "stablecoin",
    labelKey: cfg("comboPermissionedStablecoin"),
    descriptionKey: cfg("comboPermissionedStablecoinDescription"),
    settings: [],
    capacities: ["kyc", "issueRetireControls", "transferApprovals"],
    // The opposite access model AND ops model. A closed-network settlement coin:
    // only approved institutions may hold it (allowlist), and movements between
    // them are reviewed (transferApprovals) — no public redemption desk. Contrast
    // the regulated coin's open blocklist + redemption/reserve-reporting stack.
    accessControl: "allowlist",
  },
  {
    key: "regulatedSecurity",
    category: "tokenized_security",
    labelKey: cfg("comboRegulatedSecurity"),
    descriptionKey: cfg("comboRegulatedSecurityDescription"),
    settings: ["scaledUiAmount"],
    capacities: ["kyc", "transferApprovals", "investorReporting", "restrictTradingHours"],
    // The compliance base every tokenized security needs: verified investors on an
    // on-chain allowlist, reviewed transfers, market-hours trading, and reporting.
    accessControl: "allowlist",
  },
  {
    key: "fundOperations",
    category: "tokenized_security",
    labelKey: cfg("comboFundOperations"),
    descriptionKey: cfg("comboFundOperationsDescription"),
    settings: ["scaledUiAmount"],
    capacities: ["kyc", "redemptionApprovals", "issueRetireControls"],
    // A complementary lifecycle layer — subscriptions/redemptions with issuer-managed
    // supply. Same allowlist as the base, so it stacks onto regulatedSecurity (giving a
    // fund) instead of contradicting it: the two are combinable, not mutually exclusive.
    accessControl: "allowlist",
  },
  // --- generic (custom substrate, all settings available) ------------------
  {
    key: "verifiedHolders",
    category: "generic",
    labelKey: cfg("comboVerifiedHolders"),
    descriptionKey: cfg("comboVerifiedHoldersDescription"),
    settings: [],
    capacities: ["kyc"],
    // The atomic "only approved wallets" preset: verified holders = KYC (the
    // off-chain gate deciding who qualifies) + an on-chain allowlist (the
    // enforcement). The richer generic scenarios below build on this exact pair;
    // deselecting this preset cascades them off (see removeCombo).
    accessControl: "allowlist",
  },
  {
    key: "controlledAsset",
    category: "generic",
    labelKey: cfg("comboControlledAsset"),
    descriptionKey: cfg("comboControlledAssetDescription"),
    settings: ["freezeTransfers", "permanentDelegate"],
    capacities: ["kyc"],
    // "Limited to verified holders" — the allowlist is what actually enforces it.
    accessControl: "allowlist",
  },
  {
    key: "gatedAccess",
    category: "generic",
    labelKey: cfg("comboGatedAccess"),
    descriptionKey: cfg("comboGatedAccessDescription"),
    settings: ["freezeTransfers"],
    capacities: ["kyc", "restrictTradingHours"],
    // "New accounts start frozen until you approve them" — that's the allowlist.
    accessControl: "allowlist",
  },
  {
    key: "yieldNote",
    category: "generic",
    labelKey: cfg("comboYieldNote"),
    descriptionKey: cfg("comboYieldNoteDescription"),
    settings: ["interestBearing"],
    capacities: ["kyc", "issueRetireControls"],
    // "For verified holders" — enforced by the allowlist.
    accessControl: "allowlist",
  },
  {
    key: "revenueShare",
    category: "generic",
    labelKey: cfg("comboRevenueShare"),
    descriptionKey: cfg("comboRevenueShareDescription"),
    settings: ["transferFee"],
    capacities: ["issueRetireControls"],
  },
  {
    key: "loyaltyRewards",
    category: "generic",
    labelKey: cfg("comboLoyaltyRewards"),
    descriptionKey: cfg("comboLoyaltyRewardsDescription"),
    settings: ["nonTransferable"],
    capacities: ["issueRetireControls"],
  },
];

export function getCombosForCategory(category: AssetCategory): SettingCombo[] {
  return SETTING_COMBOS.filter((combo) => combo.category === category);
}

const DEFAULT_COMBO_KEY: Partial<Record<AssetCategory, string>> = {
  stablecoin: "regulatedStablecoin",
  tokenized_security: "regulatedSecurity",
};

export function getDefaultCombo(category: AssetCategory): SettingCombo | undefined {
  const key = DEFAULT_COMBO_KEY[category];
  return key ? SETTING_COMBOS.find((combo) => combo.key === key) : undefined;
}

export function comboItemLabelKeys(combo: SettingCombo): string[] {
  const settingKeys = combo.settings.map(
    (key) => (ADVANCED_SETTINGS[key] as AdvancedSetting).labelKey
  );
  const capacityKeys = combo.capacities.map((key) => CAPACITY_META[key].labelKey);
  return [...settingKeys, ...capacityKeys];
}

export function isComboActive(
  combo: SettingCombo,
  settings: AdvancedSettingsDraft,
  capacities: Record<CapacityKey, CapacitySelection>,
  accessControl: AccessControlMode | "" = ""
): boolean {
  return (
    combo.settings.every((key) => settings[key] !== undefined) &&
    combo.capacities.every((key) => capacities[key].enabled) &&
    (combo.accessControl === undefined || combo.accessControl === accessControl)
  );
}

// The plain-language reason (i18n key) each incompatible pair can't coexist,
// keyed by "extA|extB" in the order they appear in INCOMPATIBLE_EXTENSION_PAIRS.
// Must cover every pair — the dev-time assertion below enforces that, so adding a
// pair without a reason fails fast instead of silently dropping the UI conflict.
const CONFLICT_REASON_KEY: Record<string, string> = {
  "interestBearing|scaledUiAmount": "DashboardIssuance.config.comboConflictReasonBalanceDisplay",
  "nonTransferable|transferFee": "DashboardIssuance.config.comboConflictReasonNonTransferableFee",
  "nonTransferable|transferHook": "DashboardIssuance.config.comboConflictReasonNonTransferableHook",
};

// Dev-time completeness guard (skipped in production): every incompatible pair
// must have a reason key, or getComboConflict would surface a conflict the UI
// can't explain. Mirrors the capability-registry assertion in @sdp/issuance.
if (process.env.NODE_ENV !== "production") {
  for (const [a, b] of INCOMPATIBLE_EXTENSION_PAIRS) {
    if (!CONFLICT_REASON_KEY[`${a}|${b}`]) {
      throw new Error(
        `setting-combos: INCOMPATIBLE_EXTENSION_PAIRS has (${a}, ${b}) but CONFLICT_REASON_KEY ` +
          `has no "${a}|${b}" entry — add its reason i18n key.`
      );
    }
  }
}

export interface ComboConflict {
  withLabelKey: string;
  reasonKey: string;
}

export function getComboConflict(
  combo: SettingCombo,
  settings: AdvancedSettingsDraft
): ComboConflict | null {
  // Map every currently-enabled extension back to the setting that provides it.
  const currentByExt = new Map<string, SettingKey>();
  for (const key of Object.keys(settings)) {
    if (!(key in ADVANCED_SETTINGS)) {
      continue;
    }
    for (const ext of (ADVANCED_SETTINGS[key as SettingKey] as AdvancedSetting).extensions) {
      currentByExt.set(ext, key as SettingKey);
    }
  }
  const added = new Set<TokenExtensionName>(
    combo.settings.flatMap((key) => [...(ADVANCED_SETTINGS[key] as AdvancedSetting).extensions])
  );
  for (const pair of INCOMPATIBLE_EXTENSION_PAIRS) {
    let currentExt: TokenExtensionName | null = null;
    if (added.has(pair[0]) && currentByExt.has(pair[1])) {
      currentExt = pair[1];
    } else if (added.has(pair[1]) && currentByExt.has(pair[0])) {
      currentExt = pair[0];
    }
    if (!currentExt) {
      continue;
    }
    const withSettingKey = currentByExt.get(currentExt);
    if (!withSettingKey) {
      continue;
    }
    return {
      withLabelKey: (ADVANCED_SETTINGS[withSettingKey] as AdvancedSetting).labelKey,
      // Total by construction — CONFLICT_REASON_KEY covers every incompatible pair
      // (enforced by the dev-time assertion above).
      reasonKey: CONFLICT_REASON_KEY[`${pair[0]}|${pair[1]}`],
    };
  }
  return null;
}

function defaultParamsFor(key: SettingKey): Record<string, string> {
  const setting: AdvancedSetting = ADVANCED_SETTINGS[key];
  const params: Record<string, string> = {};
  for (const param of setting.params ?? []) {
    if (param.defaultValue !== undefined) {
      params[param.key] = String(param.defaultValue);
    }
  }
  return params;
}

export function applyCombo(
  combo: SettingCombo,
  settings: AdvancedSettingsDraft,
  capacities: Record<CapacityKey, CapacitySelection>,
  accessControl: AccessControlMode | "" = ""
): {
  settings: AdvancedSettingsDraft;
  capacities: Record<CapacityKey, CapacitySelection>;
  accessControl: AccessControlMode | "";
} {
  const nextSettings: AdvancedSettingsDraft = { ...settings };
  for (const key of combo.settings) {
    if (nextSettings[key] === undefined) {
      const params = defaultParamsFor(key);
      nextSettings[key] = Object.keys(params).length ? { params } : {};
    }
  }
  const nextCapacities = { ...capacities };
  for (const key of combo.capacities) {
    // Preset only flips the enable bit; any existing per-policy config is kept.
    nextCapacities[key] = { ...nextCapacities[key], enabled: true };
  }
  return {
    settings: nextSettings,
    capacities: nextCapacities,
    accessControl: combo.accessControl ?? accessControl,
  };
}

// The full defining item-set of a combo: settings, capacities, and (as a namespaced
// token) its access-control mode. Used to detect when one preset nests another.
function comboItemKeys(combo: SettingCombo): string[] {
  return [
    ...combo.settings,
    ...combo.capacities,
    ...(combo.accessControl ? [`access:${combo.accessControl}`] : []),
  ];
}

// True when `sup` contains every defining item of `sub` — i.e. `sup` is a richer
// scenario built on top of `sub` (e.g. gatedAccess ⊇ verifiedHolders).
function isSupersetOf(sup: SettingCombo, sub: SettingCombo): boolean {
  const supItems = new Set(comboItemKeys(sup));
  return comboItemKeys(sub).every((item) => supItems.has(item));
}

export function removeCombo(
  combo: SettingCombo,
  settings: AdvancedSettingsDraft,
  capacities: Record<CapacityKey, CapacitySelection>,
  otherActiveCombos: readonly SettingCombo[],
  accessControl: AccessControlMode | "" = ""
): {
  settings: AdvancedSettingsDraft;
  capacities: Record<CapacityKey, CapacitySelection>;
  accessControl: AccessControlMode | "";
} {
  // Cascade: deactivating `combo` also deactivates any other active preset built on
  // top of it (a superset of its items) — you can't keep "gated access" after
  // removing the verified-holder requirement it depends on.
  const alsoRemove = otherActiveCombos.filter((other) => isSupersetOf(other, combo));
  const keepCombos = otherActiveCombos.filter((other) => !alsoRemove.includes(other));
  const removed = [combo, ...alsoRemove];

  // Items still owned by a combo that stays active must survive the removal.
  const keepSettings = new Set<string>();
  const keepCapacities = new Set<string>();
  for (const keep of keepCombos) {
    for (const key of keep.settings) {
      keepSettings.add(key);
    }
    for (const key of keep.capacities) {
      keepCapacities.add(key);
    }
  }

  const nextSettings: AdvancedSettingsDraft = { ...settings };
  const nextCapacities = { ...capacities };
  for (const target of removed) {
    for (const key of target.settings) {
      if (!keepSettings.has(key)) {
        delete nextSettings[key];
      }
    }
    for (const key of target.capacities) {
      if (!keepCapacities.has(key)) {
        // Only clear the enable bit; keep any config the user entered so
        // re-selecting the preset restores their settings.
        nextCapacities[key] = { ...nextCapacities[key], enabled: false };
      }
    }
  }

  // Reset access control to an explicit "None" if one of the removed combos owned
  // the current mode and no combo that stays active still needs it. "disabled"
  // (not "") because deselecting a gating preset is a deliberate "no restriction"
  // choice — the row should land on None, not the blank "not chosen yet" prompt.
  let nextAccessControl: AccessControlMode | "" = accessControl;
  const removedOwnsMode = removed.some((target) => target.accessControl === accessControl);
  const keptNeedsMode = keepCombos.some((keep) => keep.accessControl === accessControl);
  if (accessControl !== "" && removedOwnsMode && !keptNeedsMode) {
    nextAccessControl = "disabled";
  }
  return { settings: nextSettings, capacities: nextCapacities, accessControl: nextAccessControl };
}
