"use client";

import { listSettingsForType } from "@sdp/issuance/capabilities";
import type { AssetCategory, SettingGroup } from "@sdp/types";
import { ChevronDown } from "lucide-react";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { AdvancedSettingsDraft } from "./issuance-draft-wizard.types";

interface AdvancedSettingsEditorProps {
  category: AssetCategory | null;
  type: string | null;
  value: AdvancedSettingsDraft;
  onChange: (next: AdvancedSettingsDraft) => void;
  disabled?: boolean;
}

// Section order + i18n label per group. Groups with no visible settings are
// omitted from the render.
const GROUP_ORDER: { group: SettingGroup; labelKey: MessageKey }[] = [
  { group: "controls", labelKey: "DashboardIssuance.config.settingGroupControls" },
  { group: "economics", labelKey: "DashboardIssuance.config.settingGroupEconomics" },
  { group: "compliance", labelKey: "DashboardIssuance.config.settingGroupCompliance" },
];

// Catalog-driven editor for on-chain advanced settings (ticket E). Renders the
// settings an asset type supports, grouped and jargon-free, with recommended
// options flagged and expert parameters behind a per-setting disclosure.
export function AdvancedSettingsEditor({
  category,
  type,
  value,
  onChange,
  disabled,
}: AdvancedSettingsEditorProps) {
  const t = useTranslations();

  if (!category || !type) {
    return null;
  }

  const available = listSettingsForType(category, type);
  if (available.length === 0) {
    return null;
  }

  const setEnabled = (key: string, enabled: boolean) => {
    const next = { ...value };
    if (enabled) {
      next[key] = value[key] ?? {};
    } else {
      delete next[key];
    }
    onChange(next);
  };

  const setParam = (key: string, paramKey: string, paramValue: string) => {
    const current = value[key] ?? {};
    onChange({
      ...value,
      [key]: { ...current, params: { ...current.params, [paramKey]: paramValue } },
    });
  };

  return (
    <div className="rounded-2xl border border-border-default bg-white p-5">
      <div>
        <p className="text-base font-medium text-primary">
          {t("DashboardIssuance.config.advancedSettingsTitle")}
        </p>
        <p className="mt-0.5 text-sm text-tertiary">
          {t("DashboardIssuance.config.advancedSettingsDescription")}
        </p>
      </div>

      <div className="mt-4 space-y-5">
        {GROUP_ORDER.map(({ group, labelKey }) => {
          const rows = available.filter((entry) => entry.setting.group === group);
          if (rows.length === 0) {
            return null;
          }
          return (
            <div key={group}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">
                {t(labelKey)}
              </p>
              <div className="grid gap-3">
                {rows.map(({ key, setting, availability }) => {
                  const selection = value[key];
                  const checked = selection !== undefined;
                  const hasParams = (setting.params?.length ?? 0) > 0;
                  return (
                    <div
                      key={key}
                      className={cn(
                        "rounded-xl border p-3 transition-colors",
                        checked
                          ? "border-primary bg-fill-subtle"
                          : "border-border-default bg-white"
                      )}
                    >
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={(event) => setEnabled(key, event.currentTarget.checked)}
                          className="mt-0.5 h-4 w-4 accent-primary"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-medium text-primary">
                              {t(setting.labelKey as MessageKey)}
                            </span>
                            {availability === "recommended" ? (
                              <span className="rounded-full bg-fill-subtle px-2 py-0.5 text-[11px] font-medium text-secondary">
                                {t("DashboardIssuance.config.settingRecommended")}
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 block text-xs text-tertiary">
                            {t(setting.descriptionKey as MessageKey)}
                          </span>
                        </span>
                      </label>

                      {checked && hasParams ? (
                        <details className="group mt-3 border-t border-border-subtle pt-3">
                          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-secondary [&::-webkit-details-marker]:hidden">
                            {t("DashboardIssuance.config.settingAdvancedOptions")}
                            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                          </summary>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            {setting.params?.map((param) => {
                              const paramValue = selection?.params?.[param.key] ?? "";
                              const inputId = `setting-${key}-${param.key}`;
                              return (
                                <div key={param.key} className="grid gap-1">
                                  <label
                                    htmlFor={inputId}
                                    className="text-xs font-medium text-secondary"
                                  >
                                    {t(param.labelKey as MessageKey)}
                                  </label>
                                  {param.kind === "select" ? (
                                    <select
                                      id={inputId}
                                      value={paramValue}
                                      disabled={disabled}
                                      onChange={(event) =>
                                        setParam(key, param.key, event.currentTarget.value)
                                      }
                                      className="rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-primary"
                                    >
                                      <option value="">—</option>
                                      {param.options?.map((option) => (
                                        <option key={option.value} value={option.value}>
                                          {t(option.labelKey as MessageKey)}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      id={inputId}
                                      type={param.kind === "number" ? "number" : "text"}
                                      value={paramValue}
                                      min={param.min}
                                      max={param.max}
                                      disabled={disabled}
                                      onChange={(event) =>
                                        setParam(key, param.key, event.currentTarget.value)
                                      }
                                      className="rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-primary"
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
