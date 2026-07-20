import {
  ADVANCED_SETTINGS,
  INCOMPATIBLE_EXTENSION_PAIRS,
  type SettingKey,
} from "@sdp/issuance/capabilities";
import type { AdvancedSetting, AssetCategory, TokenExtensionName } from "@sdp/types";
import { CAPACITY_META } from "./asset-details-config";
import type { AdvancedSettingsDraft, CapacityKey } from "./issuance-draft-wizard.types";

// Basic-mode preset: curated bundle of optional settings + capacities.
// Enables underlying settings shown in Detailed/Expert; multiple combos' settings union.
export interface SettingCombo {
  key: string;
  category: AssetCategory;
  labelKey: string;
  descriptionKey: string;
  settings: readonly SettingKey[];
  capacities: readonly CapacityKey[];
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
  },
  {
    key: "publicSecurityOffering",
    category: "tokenized_security",
    labelKey: cfg("comboPublicSecurityOffering"),
    descriptionKey: cfg("comboPublicSecurityOfferingDescription"),
    settings: ["scaledUiAmount"],
    capacities: ["kyc", "transferApprovals", "investorReporting", "restrictTradingHours"],
  },
  {
    key: "privateFund",
    category: "tokenized_security",
    labelKey: cfg("comboPrivateFund"),
    descriptionKey: cfg("comboPrivateFundDescription"),
    settings: ["scaledUiAmount"],
    capacities: ["kyc", "redemptionApprovals", "transferApprovals", "investorReporting"],
  },
  // --- generic (custom substrate, all settings available) ------------------
  {
    key: "controlledAsset",
    category: "generic",
    labelKey: cfg("comboControlledAsset"),
    descriptionKey: cfg("comboControlledAssetDescription"),
    settings: ["freezeTransfers", "permanentDelegate"],
    capacities: ["kyc"],
  },
  {
    key: "gatedAccess",
    category: "generic",
    labelKey: cfg("comboGatedAccess"),
    descriptionKey: cfg("comboGatedAccessDescription"),
    settings: ["freezeTransfers"],
    capacities: ["kyc", "restrictTradingHours"],
  },
  {
    key: "yieldNote",
    category: "generic",
    labelKey: cfg("comboYieldNote"),
    descriptionKey: cfg("comboYieldNoteDescription"),
    settings: ["interestBearing"],
    capacities: ["kyc", "issueRetireControls"],
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
  tokenized_security: "publicSecurityOffering",
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
  capacities: Record<CapacityKey, boolean>
): boolean {
  return (
    combo.settings.every((key) => settings[key] !== undefined) &&
    combo.capacities.every((key) => capacities[key] === true)
  );
}

// The plain-language reason (i18n key) each incompatible pair can't coexist,
// keyed by "extA|extB" in the order they appear in INCOMPATIBLE_EXTENSION_PAIRS.
const CONFLICT_REASON_KEY: Record<string, string | undefined> = {
  "interestBearing|scaledUiAmount": "DashboardIssuance.config.comboConflictReasonBalanceDisplay",
  "nonTransferable|transferFee": "DashboardIssuance.config.comboConflictReasonNonTransferableFee",
  "nonTransferable|transferHook": "DashboardIssuance.config.comboConflictReasonNonTransferableHook",
};

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
  capacities: Record<CapacityKey, boolean>
): { settings: AdvancedSettingsDraft; capacities: Record<CapacityKey, boolean> } {
  const nextSettings: AdvancedSettingsDraft = { ...settings };
  for (const key of combo.settings) {
    if (nextSettings[key] === undefined) {
      const params = defaultParamsFor(key);
      nextSettings[key] = Object.keys(params).length ? { params } : {};
    }
  }
  const nextCapacities = { ...capacities };
  for (const key of combo.capacities) {
    nextCapacities[key] = true;
  }
  return { settings: nextSettings, capacities: nextCapacities };
}

export function removeCombo(
  combo: SettingCombo,
  settings: AdvancedSettingsDraft,
  capacities: Record<CapacityKey, boolean>,
  otherActiveCombos: readonly SettingCombo[]
): { settings: AdvancedSettingsDraft; capacities: Record<CapacityKey, boolean> } {
  const keepSettings = new Set<string>();
  const keepCapacities = new Set<string>();
  for (const other of otherActiveCombos) {
    for (const key of other.settings) {
      keepSettings.add(key);
    }
    for (const key of other.capacities) {
      keepCapacities.add(key);
    }
  }
  const nextSettings: AdvancedSettingsDraft = { ...settings };
  for (const key of combo.settings) {
    if (!keepSettings.has(key)) {
      delete nextSettings[key];
    }
  }
  const nextCapacities = { ...capacities };
  for (const key of combo.capacities) {
    if (!keepCapacities.has(key)) {
      nextCapacities[key] = false;
    }
  }
  return { settings: nextSettings, capacities: nextCapacities };
}
