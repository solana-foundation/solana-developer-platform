// Workflow capability gate (Ticket 5): "can this asset actually perform this action?"
// Pure, mosaic-free — reused at save time (reject bad rules) and execution time
// (revalidate before running). Mirrors capabilities/index.ts validation style.

import type { AssetCategory, SelectedSetting, WorkflowActionType } from "@sdp/types";
// Import the catalog directly (not ../capabilities/index) to avoid its dev-time assertion
// side effects; ADVANCED_SETTINGS is the same `actions` data the settings resolver consumes.
import {
  ADVANCED_SETTINGS,
  expandLegacySettingKeys,
  type SettingKey,
} from "../capabilities/settings";
import { WORKFLOW_ACTIONS } from "./actions";

export type ActionSupportReason =
  | "unknown_action"
  | "no_allowlist"
  | "capability_disabled"
  | "not_mintable";

export type ActionSupportResult = { ok: true } | { ok: false; reason: ActionSupportReason };

export interface ValidateActionInput {
  action: WorkflowActionType;
  category: AssetCategory;
  type: string;
  // The asset's enabled advanced settings (as persisted under issuance_metadata.settings).
  selectedSettings: Record<string, SelectedSetting>;
  // Whether the token has an allowlist (ablListAddress present).
  hasAllowlist: boolean;
  // Whether the token still has a live mint authority. Optional so callers that only
  // gate non-supply actions don't have to load it; when omitted the mint check is
  // skipped rather than assumed false.
  isMintable?: boolean;
}

// True if any enabled setting unlocks the given Token-2022 action. Stored selections
// may still carry retired keys (e.g. "freezeTransfers"), so expand legacy aliases
// before matching — otherwise an asset saved before a catalog rename would wrongly
// fail the gate as capability_disabled.
function selectedSettingsUnlock(
  selectedSettings: Record<string, SelectedSetting>,
  action: string
): boolean {
  const expanded = expandLegacySettingKeys(selectedSettings);
  for (const key of Object.keys(expanded)) {
    if (!(key in ADVANCED_SETTINGS)) {
      continue;
    }
    const setting = ADVANCED_SETTINGS[key as SettingKey];
    if ((setting.actions as readonly string[]).includes(action)) {
      return true;
    }
  }
  return false;
}

// Single gate used save-time and execution-time. `category`/`type` reserved for future
// per-type refinement; today the decision is driven by selected settings + allowlist.
export function validateActionSupported(input: ValidateActionInput): ActionSupportResult {
  const action = WORKFLOW_ACTIONS[input.action];
  if (!action) {
    return { ok: false, reason: "unknown_action" };
  }
  const requires = action.requires;
  switch (requires.kind) {
    case "none":
      // Pure side effects (webhook, notify, record) need no asset capability.
      return { ok: true };
    case "base":
      // Base ops carry no advanced-setting gate, but minting still needs a live mint
      // authority — without this the two most destructive actions get the weakest check.
      return requires.action === "mint" && input.isMintable === false
        ? { ok: false, reason: "not_mintable" }
        : { ok: true };
    case "allowlist":
      return input.hasAllowlist ? { ok: true } : { ok: false, reason: "no_allowlist" };
    case "token_transaction":
      return selectedSettingsUnlock(input.selectedSettings, requires.action)
        ? { ok: true }
        : { ok: false, reason: "capability_disabled" };
  }
}
