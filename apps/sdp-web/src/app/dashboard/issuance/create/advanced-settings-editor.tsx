"use client";

import { type GroupedSetting, listSettingsForType } from "@sdp/issuance/capabilities";
import type { AssetCategory } from "@sdp/types";
import { ChevronDown } from "lucide-react";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import type { AccessControlMode, AdvancedSettingsDraft } from "./issuance-draft-wizard.types";
import { RecipientControlSelect } from "./recipient-control-select";
import { TokenControlRow } from "./token-control-row";
import {
  type ControlEditMode,
  findControlConflict,
  groupTokenControls,
  SIMPLE_CONTROL_LABELS,
  toggleTokenControl,
} from "./token-controls-model";

const CONTROL_MEANINGS: Record<string, [MessageKey, MessageKey]> = {
  pauseTransfers: ["DashboardIssuance.ux.pauseLabel", "DashboardIssuance.ux.pauseMeaning"],
  freezeAccounts: ["DashboardIssuance.ux.freezeLabel", "DashboardIssuance.ux.freezeMeaning"],
  permanentDelegate: ["DashboardIssuance.ux.recoveryLabel", "DashboardIssuance.ux.recoveryMeaning"],
};

interface AdvancedSettingsEditorProps {
  category: AssetCategory | null;
  type: string | null;
  settings: AdvancedSettingsDraft;
  onSettingsChange: (next: AdvancedSettingsDraft) => void;
  mode: ControlEditMode;
  showErrors?: boolean;
  accessControl?: AccessControlMode | "";
  onAccessControlChange?: (mode: AccessControlMode | "") => void;
}

export function AdvancedSettingsEditor({
  category,
  type,
  settings,
  onSettingsChange,
  mode,
  showErrors = false,
  accessControl = "",
  onAccessControlChange,
}: AdvancedSettingsEditorProps) {
  const t = useTranslations();
  if (!category || !type) return null;
  const entries = listSettingsForType(category, type);
  const { primary, included, advanced } = groupTokenControls(entries, settings, mode);
  const renderControl = (entry: GroupedSetting, variant: "primary" | "advanced") => {
    const conflict = findControlConflict(entry, entries, settings);
    return (
      <TokenControlRow
        key={entry.key}
        entry={entry}
        variant={variant}
        mode={mode}
        selection={settings[entry.key]}
        showErrors={showErrors}
        conflictWith={conflict ? t(conflict.setting.labelKey as MessageKey) : undefined}
        onToggle={(enabled) => onSettingsChange(toggleTokenControl(settings, entry, enabled))}
        onParam={(key, value) =>
          onSettingsChange({
            ...settings,
            [entry.key]: {
              ...settings[entry.key],
              params: { ...settings[entry.key]?.params, [key]: value },
            },
          })
        }
      />
    );
  };
  if (mode === "readonly") {
    return (
      <section className="border-t border-border-subtle pt-5">
        <h3 className="mb-2 text-sm font-medium text-primary">
          {t("DashboardIssuance.ux.holderRules")}
        </h3>
        <dl className="divide-y divide-border-subtle text-sm">
          <div className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] sm:gap-6">
            <dt className="text-tertiary">{t("DashboardIssuance.ux.recipients")}</dt>
            <dd className="text-primary sm:text-right">
              {t(
                accessControl === "allowlist"
                  ? "DashboardIssuance.ux.approvedOnly"
                  : accessControl === "blocklist"
                    ? "DashboardIssuance.ux.exceptBlocked"
                    : "DashboardIssuance.ux.anyRecipient"
              )}
            </dd>
          </div>
          {[...included, ...primary].map((entry) => {
            const copy = CONTROL_MEANINGS[entry.key];
            if (!copy) return null;
            return (
              <div
                key={entry.key}
                className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] sm:gap-6"
              >
                <dt className="text-tertiary">{t(copy[0])}</dt>
                <dd className="text-primary sm:text-right">{t(copy[1])}</dd>
              </div>
            );
          })}
        </dl>
        {advanced.length ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-secondary">
              {t("DashboardIssuance.simplified.advancedControls")}
            </summary>
            <div className="mt-3 space-y-3">
              {advanced.map((entry) => renderControl(entry, "advanced"))}
            </div>
          </details>
        ) : null}
      </section>
    );
  }
  return (
    <section>
      <p className="mt-0.5 text-xs text-tertiary">
        {t("DashboardIssuance.simplified.fixedAfterDeployment")}
      </p>
      <div className="mt-3 grid gap-2.5">
        {onAccessControlChange ? (
          <RecipientControlSelect
            value={accessControl}
            disabled={mode !== "editable"}
            onChange={onAccessControlChange}
          />
        ) : null}
        {included.length ? (
          <div className="py-3">
            <h4 className="text-sm font-medium text-primary">
              {t(
                category === "stablecoin"
                  ? "DashboardIssuance.simplified.includedStablecoin"
                  : "DashboardIssuance.simplified.includedControls"
              )}
            </h4>
            <ul className="mt-2 space-y-2 text-sm text-secondary">
              {included.map((entry) => (
                <li key={entry.key}>
                  {t((SIMPLE_CONTROL_LABELS[entry.key] ?? entry.setting.labelKey) as MessageKey)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {primary.map((entry) => renderControl(entry, "primary"))}
        {advanced.length ? (
          <details className="group mt-2 border-t border-border-subtle pt-4" open={showErrors}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-secondary [&::-webkit-details-marker]:hidden">
              {t("DashboardIssuance.simplified.advancedControls")}
              <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-4 grid gap-2.5">
              {advanced.map((entry) => renderControl(entry, "advanced"))}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}
