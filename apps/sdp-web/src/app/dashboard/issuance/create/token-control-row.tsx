"use client";

import type { GroupedSetting } from "@sdp/issuance/capabilities";
import { Lock } from "lucide-react";
import { useId } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import type { AdvancedSettingsDraft } from "./issuance-draft-wizard.types";
import { TokenControlParameters } from "./token-control-parameters";
import { type ControlEditMode, SIMPLE_CONTROL_LABELS } from "./token-controls-model";

export function TokenControlRow({
  entry,
  selection,
  variant,
  mode,
  conflictWith,
  showErrors,
  onToggle,
  onParam,
}: {
  entry: GroupedSetting;
  selection: AdvancedSettingsDraft[string] | undefined;
  variant: "primary" | "advanced";
  mode: ControlEditMode;
  conflictWith?: string;
  showErrors: boolean;
  onToggle: (enabled: boolean) => void;
  onParam: (key: string, value: string) => void;
}) {
  const t = useTranslations();
  const id = useId();
  const checked = entry.availability === "locked" || selection !== undefined;
  const locked = entry.availability === "locked" || (mode === "readonly" && checked);
  const disabled = mode !== "editable" || locked || Boolean(conflictWith);
  const label = t((SIMPLE_CONTROL_LABELS[entry.key] ?? entry.setting.labelKey) as MessageKey);
  return (
    <div className="rounded-xl border border-border-default bg-surface-raised">
      <div className="flex items-center gap-3 px-4 py-4">
        <label htmlFor={id} className="min-w-0 flex-1">
          <span className="text-sm font-medium text-primary">{label}</span>
          {variant === "primary" ? (
            <span className="mt-0.5 block text-xs text-tertiary">
              {t(entry.setting.descriptionKey as MessageKey)}
            </span>
          ) : null}
        </label>
        {locked ? (
          <span title={t("DashboardIssuance.config.settingLockedHint")}>
            <Lock className="size-3.5 text-tertiary" aria-hidden />
          </span>
        ) : null}
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onToggle(event.currentTarget.checked)}
          className={locked ? "sr-only" : "size-4 shrink-0 accent-primary disabled:opacity-60"}
        />
      </div>
      <TokenControlParameters
        entry={entry}
        selection={selection}
        conflictWith={conflictWith}
        showErrors={showErrors}
        disabled={disabled}
        onParam={onParam}
      />
    </div>
  );
}
