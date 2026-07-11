"use client";

import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp-support";
import { fiatCurrencyDisplayName, fiatCurrencyFlagEmoji } from "@sdp/types/payment-rails";
import { type LucideIcon, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { FieldDescriptor } from "./asset-details-config";
import type { CustomFieldRow, DraftState } from "./issuance-draft-wizard.types";

type UpdateDraft = (patch: Partial<DraftState>) => void;

const FIAT_CURRENCY_OPTIONS: readonly ComboboxOption[] = RAMP_FIAT_CURRENCIES.map((code) => {
  const flag = fiatCurrencyFlagEmoji(code);
  return {
    value: code,
    label: flag === null ? code : `${flag} ${code}`,
    description: fiatCurrencyDisplayName(code),
  };
});

export function FormCard({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
      <div className="flex items-start gap-3">
        {Icon ? (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]">
            <Icon className="h-4.5 w-4.5" />
          </span>
        ) : null}
        <div>
          <p className="text-base font-medium text-[#1c1c1d]">{title}</p>
          {description ? (
            <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">{description}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  type = "text",
  help,
  required,
  error,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  help?: string;
  required?: boolean;
  error?: string;
}) {
  const t = useTranslations();
  return (
    <div className="grid gap-1.5">
      <Label>
        {label}
        {required ? (
          <>
            {" "}
            <span aria-hidden className="text-[#c71f37]">
              *
            </span>
            <span className="sr-only"> {t("DashboardIssuance.create.required")}</span>
          </>
        ) : null}
      </Label>
      <Input
        type={type}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        required={required}
        error={error}
        description={help}
      />
    </div>
  );
}

export function ReadOnlyField({
  label,
  value,
  lockReason,
}: {
  label: string;
  value: string;
  lockReason?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="flex h-10 items-center rounded-[14px] border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] px-4 text-sm text-[rgba(28,28,29,0.62)]">
        {value || "—"}
      </div>
      {lockReason ? <p className="text-xs text-[rgba(28,28,29,0.5)]">{lockReason}</p> : null}
    </div>
  );
}

export function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors",
        checked ? "bg-[#1c1c1d]" : "bg-[rgba(28,28,29,0.2)]"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0"
        )}
      />
    </button>
  );
}

export function DetailField({
  field,
  draft,
  updateDraft,
  required,
  error,
  disabled,
}: {
  field: FieldDescriptor;
  draft: DraftState;
  updateDraft: UpdateDraft;
  required?: boolean;
  error?: string;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const raw = draft[field.key];

  if (field.control === "toggle") {
    const checked = Boolean(raw);
    return (
      <div>
        <Label>{t(field.labelKey)}</Label>
        <div className="mt-1.5 flex items-center gap-2">
          <ToggleSwitch
            checked={checked}
            disabled={disabled}
            onChange={(next) => updateDraft({ [field.key]: next } as Partial<DraftState>)}
          />
          <span className="text-sm text-[rgba(28,28,29,0.6)]">
            {checked
              ? t("DashboardIssuance.summary.enabled")
              : t("DashboardIssuance.status.revoked")}
          </span>
        </div>
        {field.helpKey ? (
          <p className="mt-1 text-xs text-[rgba(28,28,29,0.5)]">{t(field.helpKey)}</p>
        ) : null}
      </div>
    );
  }

  if (field.control === "currency") {
    const value = typeof raw === "string" ? raw : "";
    return (
      <Combobox
        label={field.label}
        required={required}
        disabled={disabled}
        value={value || null}
        onChange={(next) => updateDraft({ [field.key]: next } as Partial<DraftState>)}
        options={FIAT_CURRENCY_OPTIONS}
        size="lg"
        variant="dialog"
        placeholder={`Select ${field.label.toLowerCase()}`}
        searchPlaceholder="Search currencies"
        validationError={error}
        className="border-[length:var(--input-border-width)] border-[var(--input-border-idle)] bg-[var(--input-bg-idle)] text-sm hover:border-[var(--input-border-hover)] hover:bg-[var(--input-bg-hover)]"
      />
    );
  }

  if (field.control === "select") {
    const value = typeof raw === "string" ? raw : "";
    return (
      <div>
        <Label>
          {t(field.labelKey)}
          {required ? (
            <>
              {" "}
              <span aria-hidden className="text-[#c71f37]">
                *
              </span>
              <span className="sr-only"> {t("DashboardIssuance.create.required")}</span>
            </>
          ) : null}
        </Label>
        <div className="mt-1.5">
          <Select
            className={cn(error && "ring-2 ring-inset ring-[#c71f37]")}
            disabled={disabled}
            value={value || null}
            onValueChange={(next) =>
              updateDraft({ [field.key]: next ?? "" } as Partial<DraftState>)
            }
            placeholder={t(field.labelKey)}
          >
            {field.options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </Select>
        </div>
        {error ? (
          <p className="mt-1 text-xs text-[#c71f37]" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const value = typeof raw === "string" ? raw : "";
  return (
    <TextField
      label={t(field.labelKey)}
      required={required}
      disabled={disabled}
      value={value}
      onChange={(next) => updateDraft({ [field.key]: next } as Partial<DraftState>)}
      placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
      type={field.control === "number" ? "number" : "text"}
      help={field.helpKey ? t(field.helpKey) : undefined}
      error={error}
    />
  );
}

export function CustomFieldRows({
  fields,
  onChange,
  disabled,
}: {
  fields: CustomFieldRow[];
  onChange: (fields: CustomFieldRow[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const update = (id: string, patch: Partial<CustomFieldRow>) =>
    onChange(fields.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  const remove = (id: string) => onChange(fields.filter((field) => field.id !== id));

  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <div key={field.id} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
          <Input
            placeholder={t("DashboardIssuance.assetDetails.customFieldKey")}
            disabled={disabled}
            value={field.key}
            onChange={(event) => update(field.id, { key: event.currentTarget.value })}
          />
          <Input
            placeholder={t("DashboardIssuance.assetDetails.customFieldValue")}
            disabled={disabled}
            value={field.value}
            onChange={(event) => update(field.id, { value: event.currentTarget.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onClick={() => remove(field.id)}
            aria-label={t("DashboardIssuance.assetDetails.removeCustomField")}
            className="self-center text-status-error-text hover:bg-status-error-bg hover:text-status-error-text"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...fields, { id: crypto.randomUUID(), key: "", value: "" }])}
        iconLeft={<Plus className="h-4 w-4" />}
      >
        {t("DashboardIssuance.assetDetails.addCustomField")}
      </Button>
    </div>
  );
}
