import type { SelectedSetting, WorkflowActionType } from "@sdp/types";
import {
  ADVANCED_SETTINGS,
  expandLegacySettingKeys,
  type SettingKey,
} from "../capabilities/settings";
import { WORKFLOW_ACTIONS } from "./actions";

export type ActionUnsupportedReason =
  | "unknown_action"
  | "no_allowlist"
  | "capability_disabled"
  | "not_mintable";

export type ActionSupportResult = { ok: true } | { ok: false; reason: ActionUnsupportedReason };

export interface ValidateActionInput {
  action: WorkflowActionType;
  selectedSettings: Record<string, SelectedSetting>;
  hasAllowlist: boolean;
  isMintable?: boolean;
}

/**
 * True if any enabled setting unlocks the given Token-2022 action.
 *
 * Imports the catalog directly (not `../capabilities/index`) to avoid its
 * dev-time assertion side effects — `ADVANCED_SETTINGS` is the same `actions`
 * data the settings resolver consumes. Stored selections may still carry
 * retired keys (e.g. "freezeTransfers"), so legacy aliases are expanded
 * before matching — otherwise an asset saved before a catalog rename would
 * wrongly fail the gate as capability_disabled.
 *
 * @param selectedSettings - The asset's enabled advanced settings.
 * @param action - The Token-2022 action to check.
 * @returns Whether an enabled setting unlocks the action.
 */
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

/**
 * Workflow capability gate: whether an asset can actually perform a given
 * action. Pure and mosaic-free, used at save time (reject bad rules) and
 * execution time (revalidate before running). `isMintable` is optional so
 * callers that only gate non-supply actions don't have to load it; when
 * omitted the mint check is skipped rather than assumed false.
 *
 * @param input - The action to validate plus the asset's capability state.
 * @returns Whether the action is supported, or the reason it is not.
 */
export function validateActionSupported(input: ValidateActionInput): ActionSupportResult {
  const action = WORKFLOW_ACTIONS[input.action];
  if (!action) {
    return { ok: false, reason: "unknown_action" };
  }
  const requires = action.requires;
  switch (requires.kind) {
    case "none":
      return { ok: true };
    case "native":
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
