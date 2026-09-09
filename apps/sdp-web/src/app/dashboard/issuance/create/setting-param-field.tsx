"use client";

import type { ParamFieldSpec } from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export function SettingParamField({
  param,
  settingKey,
  value,
  invalid,
  disabled,
  onChange,
}: {
  param: ParamFieldSpec;
  settingKey: string;
  value: string;
  invalid: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations();
  const inputId = `setting-${settingKey}-${param.key}`;
  const inputClass = cn(
    "rounded-lg border bg-surface-raised px-3 py-2 text-sm text-primary outline-none transition-colors",
    invalid ? "border-destructive" : "border-border-default focus:border-border-strong"
  );
  return (
    <div className="grid gap-1">
      <label
        htmlFor={inputId}
        className="flex items-center gap-1 text-xs font-medium text-secondary"
      >
        {t(param.labelKey as MessageKey)}
        {param.required ? (
          <span aria-hidden className="text-destructive">
            *
          </span>
        ) : null}
      </label>
      {param.kind === "select" ? (
        <select
          id={inputId}
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
          className={inputClass}
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
          value={value}
          min={param.min}
          max={param.max}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
          className={inputClass}
        />
      )}
      {invalid ? (
        <p className="-mt-0.5 ml-[5px] text-[10px] leading-tight text-destructive" role="alert">
          {t("DashboardIssuance.errors.settingValueRequired")}
        </p>
      ) : null}
      {param.hintKey ? (
        <p className="ml-[5px] text-[10px] leading-tight text-tertiary">
          {t(param.hintKey as MessageKey)}
        </p>
      ) : null}
    </div>
  );
}
