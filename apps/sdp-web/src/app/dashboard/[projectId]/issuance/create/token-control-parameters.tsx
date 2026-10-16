"use client";

import type { GroupedSetting } from "@sdp/issuance/capabilities";
import { useTranslations } from "@/i18n/provider";
import type { AdvancedSettingsDraft } from "./issuance-draft-wizard.types";
import { SettingParamField } from "./setting-param-field";

export function TokenControlParameters({
  entry,
  selection,
  conflictWith,
  showErrors,
  disabled,
  onParam,
}: {
  entry: GroupedSetting;
  selection: AdvancedSettingsDraft[string] | undefined;
  conflictWith?: string;
  showErrors: boolean;
  disabled: boolean;
  onParam: (key: string, value: string) => void;
}) {
  const t = useTranslations();
  if (conflictWith)
    return (
      <p className="mx-3 mb-3 border-t border-border-subtle pt-2 text-xs text-tertiary">
        {t("DashboardIssuance.config.settingConflictsWith")} {conflictWith}
      </p>
    );
  const checked = entry.availability === "locked" || selection !== undefined;
  const params = entry.setting.params ?? [];
  if (!checked || !params.length) return null;
  return (
    <div className="mx-3 mb-3 grid items-start gap-x-3 gap-y-2 border-t border-border-subtle pt-2.5 sm:grid-cols-2">
      {params.map((param) => {
        const value = selection?.params?.[param.key] ?? "";
        return (
          <SettingParamField
            key={param.key}
            param={param}
            settingKey={entry.key}
            value={value}
            invalid={showErrors && Boolean(param.required) && value.trim() === ""}
            disabled={disabled}
            onChange={(next) => onParam(param.key, next)}
          />
        );
      })}
    </div>
  );
}
