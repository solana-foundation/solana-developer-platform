"use client";

import type { GroupedSetting } from "@sdp/issuance/capabilities";
import { Lock, TriangleAlert } from "lucide-react";
import { useId } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import type { AdvancedSettingsDraft } from "./issuance-draft-wizard.types";
import { TokenControlParameters } from "./token-control-parameters";
import {
  type ControlEditMode,
  SIMPLE_CONTROL_LABELS,
  settlementBlockedMessageKey,
} from "./token-controls-model";

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
  // Extensions are fixed at mint time, so this has to be readable while the box
  // is still unticked. A warning that appeared on selection would arrive after
  // the decision it exists to inform.
  const settlementBlockedKey = settlementBlockedMessageKey(entry.key);
  return (
    <div className="rounded-xl border border-border-default bg-surface-raised">
      <div className="flex items-center gap-3 px-4 py-4">
        <label htmlFor={id} className="min-w-0 flex-1">
          <span className="text-sm font-medium text-primary">{label}</span>
          {settlementBlockedKey ? (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-[11px] font-medium text-warning">
              <TriangleAlert className="size-3" aria-hidden />
              {t("DashboardIssuance.config.settlementBlockedBadge")}
            </span>
          ) : null}
          {variant === "primary" ? (
            <span className="mt-0.5 block text-xs text-tertiary">
              {t(entry.setting.descriptionKey as MessageKey)}
            </span>
          ) : null}
          {settlementBlockedKey ? (
            <span className="mt-0.5 block text-xs text-warning">{t(settlementBlockedKey)}</span>
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
        disabled={mode !== "editable"}
        onParam={onParam}
      />
    </div>
  );
}
