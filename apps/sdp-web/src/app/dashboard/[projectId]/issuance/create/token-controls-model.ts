import {
  dvpBlockReason,
  type GroupedSetting,
  getConflictingSettingKeys,
  type SettingKey,
} from "@sdp/issuance/capabilities";
import type { MessageKey } from "@/i18n/messages";
import type { AdvancedSettingsDraft } from "./issuance-draft-wizard.types";

/**
 * The message naming why an extension rules an asset out of DvP settlement, or
 * null when the program accepts it.
 *
 * Lives here rather than in a row component because two unrelated surfaces need
 * it: the capability-driven rows on the asset profile, and the draft form's own
 * hand-rolled controls. One lookup keeps them from drifting apart.
 */
export function settlementBlockedMessageKey(key: SettingKey): MessageKey | null {
  const reason = dvpBlockReason(key);
  if (!reason) return null;
  return reason === "amountMutating"
    ? "DashboardIssuance.config.settlementBlockedAmount"
    : "DashboardIssuance.config.settlementBlockedEscrow";
}

export const SIMPLE_CONTROL_LABELS: Partial<Record<SettingKey, MessageKey>> = {
  pauseTransfers: "DashboardIssuance.simplified.pauseCapability",
  freezeAccounts: "DashboardIssuance.simplified.freezeBalances",
  permanentDelegate: "DashboardIssuance.simplified.recoveryAuthority",
};

export type ControlEditMode = "editable" | "disabled" | "readonly";

export function groupTokenControls(
  entries: GroupedSetting[],
  settings: AdvancedSettingsDraft,
  mode: ControlEditMode
) {
  const primary: GroupedSetting[] = [];
  const included: GroupedSetting[] = [];
  const advanced: GroupedSetting[] = [];
  for (const entry of entries) {
    const selected = entry.availability === "locked" || settings[entry.key] !== undefined;
    if (mode === "readonly" && !selected) continue;
    if (!(entry.key in SIMPLE_CONTROL_LABELS)) advanced.push(entry);
    else if (entry.availability === "locked") included.push(entry);
    else primary.push(entry);
  }
  return { primary, included, advanced };
}

export function findControlConflict(
  entry: GroupedSetting,
  entries: GroupedSetting[],
  settings: AdvancedSettingsDraft
) {
  if (settings[entry.key] !== undefined || entry.availability === "locked") return undefined;
  const conflicts = new Set(getConflictingSettingKeys(entry.key));
  return entries.find(
    (candidate) =>
      conflicts.has(candidate.key) &&
      (candidate.availability === "locked" || settings[candidate.key] !== undefined)
  );
}

export function toggleTokenControl(
  settings: AdvancedSettingsDraft,
  entry: GroupedSetting,
  enabled: boolean
): AdvancedSettingsDraft {
  if (entry.availability === "locked") return settings;
  const next = { ...settings };
  if (!enabled) {
    delete next[entry.key];
    return next;
  }
  const params: Record<string, string> = {};
  for (const param of entry.setting.params ?? []) {
    if (param.defaultValue !== undefined) params[param.key] = String(param.defaultValue);
  }
  next[entry.key] = settings[entry.key] ?? (Object.keys(params).length ? { params } : {});
  return next;
}
