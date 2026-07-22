"use client";

import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  CAPACITY_META,
  defaultCapacityConfig,
  TIMEZONE_OPTIONS,
  TRADING_HOURS_SCHEDULE_OPTIONS,
  TRANSFER_APPROVAL_RULE_OPTIONS,
  WEEKDAY_OPTIONS,
} from "./asset-details-config";
import {
  type CapacityConfig,
  type CapacityKey,
  type TradingHoursConfig,
  type TradingHoursSchedule,
  type TransferApprovalRule,
  type TransferApprovalsConfig,
  WEEKDAYS,
  type Weekday,
} from "./issuance-draft-wizard.types";

// Shared control styling, mirroring the editor's ParamField so the modal reads as
// the same family as the on-chain param inputs.
const INPUT_CLASS =
  "rounded-lg border border-border-default bg-surface-raised px-3 py-2 text-sm text-primary outline-none transition-colors focus:border-border-strong";

interface CapacityConfigModalProps {
  // The capacity being configured, or null when the modal is closed.
  capKey: CapacityKey | null;
  config: CapacityConfig | undefined;
  disabled?: boolean;
  onClose: () => void;
  onSave: (config: CapacityConfig | undefined) => void;
}

// Per-policy configuration modal. The declaration layer (the checkbox) enables a
// policy; this edits how it works. Keyed on capKey so the form state resets each
// time a different policy is opened.
export function CapacityConfigModal({
  capKey,
  config,
  disabled,
  onClose,
  onSave,
}: CapacityConfigModalProps) {
  const t = useTranslations();
  return (
    <Modal
      isOpen={capKey !== null}
      onClose={onClose}
      closeDisabled={disabled}
      ariaLabel={capKey ? t(CAPACITY_META[capKey].labelKey) : ""}
      contentClassName="border-border-default p-5"
      size="md"
    >
      {capKey ? (
        <ConfigForm
          key={capKey}
          capKey={capKey}
          initialConfig={config}
          disabled={disabled}
          onCancel={onClose}
          onSave={(next) => {
            onSave(next);
            onClose();
          }}
        />
      ) : null}
    </Modal>
  );
}

function ConfigForm({
  capKey,
  initialConfig,
  disabled,
  onCancel,
  onSave,
}: {
  capKey: CapacityKey;
  initialConfig: CapacityConfig | undefined;
  disabled?: boolean;
  onCancel: () => void;
  onSave: (config: CapacityConfig | undefined) => void;
}) {
  const t = useTranslations();
  const [config, setConfig] = useState<CapacityConfig | undefined>(
    initialConfig ?? defaultCapacityConfig(capKey)
  );
  const policyName = t(CAPACITY_META[capKey].labelKey);

  return (
    <>
      <h4 className="pr-10 text-lg font-medium text-primary">
        {t("DashboardIssuance.config.capacityConfig.editTitle", { policy: policyName })}
      </h4>
      <p className="mt-1 text-sm text-tertiary">{t(CAPACITY_META[capKey].descriptionKey)}</p>

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(cleanConfig(capKey, config));
        }}
      >
        {capKey === "restrictTradingHours" ? (
          <TradingHoursFields
            value={config as TradingHoursConfig | undefined}
            onChange={setConfig}
            disabled={disabled}
          />
        ) : null}
        {capKey === "transferApprovals" ? (
          <TransferApprovalsFields
            value={config as TransferApprovalsConfig | undefined}
            onChange={setConfig}
            disabled={disabled}
          />
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onCancel} disabled={disabled}>
            {t("DashboardIssuance.config.capacityConfig.cancel")}
          </Button>
          <Button type="submit" disabled={disabled}>
            {t("DashboardIssuance.config.capacityConfig.save")}
          </Button>
        </div>
      </form>
    </>
  );
}

// A labelled field wrapper.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-secondary">{label}</span>
      {children}
    </label>
  );
}

// A small segmented (single-choice) control, matching the access-control row.
function Segmented({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div
      className="flex rounded-lg border border-border-default bg-fill-subtle p-0.5"
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex flex-1 items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            value === option.value ? "bg-surface-raised text-primary" : "text-tertiary hover:text-primary",
            disabled && "cursor-not-allowed"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function TradingHoursFields({
  value,
  onChange,
  disabled,
}: {
  value: TradingHoursConfig | undefined;
  onChange: (config: TradingHoursConfig) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const schedule: TradingHoursSchedule = value?.schedule ?? "market_hours";
  const days = value?.days ?? [];
  // Preserve everything else while patching one field.
  const patch = (next: Partial<TradingHoursConfig>) => onChange({ ...value, schedule, ...next });

  const toggleDay = (day: Weekday) => {
    const set = new Set(days);
    if (set.has(day)) {
      set.delete(day);
    } else {
      set.add(day);
    }
    // Keep the canonical Mon→Sun order regardless of click order.
    patch({ days: WEEKDAYS.filter((d) => set.has(d)) });
  };

  return (
    <div className="space-y-4">
      <Field label={t("DashboardIssuance.config.capacityConfig.tradingHours.scheduleLabel")}>
        <Segmented
          ariaLabel={t("DashboardIssuance.config.capacityConfig.tradingHours.scheduleLabel")}
          value={schedule}
          disabled={disabled}
          onChange={(next) => onChange({ ...value, schedule: next as TradingHoursSchedule })}
          options={TRADING_HOURS_SCHEDULE_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
        />
      </Field>

      {schedule === "custom" ? (
        <>
          <Field label={t("DashboardIssuance.config.capacityConfig.tradingHours.daysLabel")}>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_OPTIONS.map((day) => {
                const active = days.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    disabled={disabled}
                    aria-pressed={active}
                    onClick={() => toggleDay(day.value)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                      active
                        ? "border-primary text-primary"
                        : "border-border-default text-tertiary hover:text-primary",
                      disabled && "cursor-not-allowed"
                    )}
                  >
                    {t(day.labelKey)}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("DashboardIssuance.config.capacityConfig.tradingHours.opensLabel")}>
              <input
                type="time"
                className={INPUT_CLASS}
                value={value?.open ?? ""}
                disabled={disabled}
                onChange={(event) => patch({ open: event.currentTarget.value })}
              />
            </Field>
            <Field label={t("DashboardIssuance.config.capacityConfig.tradingHours.closesLabel")}>
              <input
                type="time"
                className={INPUT_CLASS}
                value={value?.close ?? ""}
                disabled={disabled}
                onChange={(event) => patch({ close: event.currentTarget.value })}
              />
            </Field>
          </div>
        </>
      ) : null}

      {schedule !== "24_7" ? (
        <Field label={t("DashboardIssuance.config.capacityConfig.tradingHours.timezoneLabel")}>
          <select
            className={INPUT_CLASS}
            value={value?.timezone ?? ""}
            disabled={disabled}
            onChange={(event) => patch({ timezone: event.currentTarget.value || undefined })}
          >
            <option value="">—</option>
            {TIMEZONE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
    </div>
  );
}

function TransferApprovalsFields({
  value,
  onChange,
  disabled,
}: {
  value: TransferApprovalsConfig | undefined;
  onChange: (config: TransferApprovalsConfig) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const rule: TransferApprovalRule = value?.rule ?? "all";
  const approvers = value?.approvers ?? [];
  const patch = (next: Partial<TransferApprovalsConfig>) => onChange({ ...value, rule, ...next });

  return (
    <div className="space-y-4">
      <Field label={t("DashboardIssuance.config.capacityConfig.transferApprovals.ruleLabel")}>
        <Segmented
          ariaLabel={t("DashboardIssuance.config.capacityConfig.transferApprovals.ruleLabel")}
          value={rule}
          disabled={disabled}
          onChange={(next) => onChange({ ...value, rule: next as TransferApprovalRule })}
          options={TRANSFER_APPROVAL_RULE_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
        />
      </Field>

      {rule === "above_amount" ? (
        <Field label={t("DashboardIssuance.config.capacityConfig.transferApprovals.amountLabel")}>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              className={cn(INPUT_CLASS, "flex-1")}
              value={value?.amount ?? ""}
              placeholder={t("DashboardIssuance.config.capacityConfig.transferApprovals.amountPlaceholder")}
              disabled={disabled}
              onChange={(event) => patch({ amount: event.currentTarget.value.replace(/[^\d]/g, "") })}
            />
            <span className="text-sm text-tertiary">
              {t("DashboardIssuance.config.capacityConfig.transferApprovals.amountSuffix")}
            </span>
          </div>
        </Field>
      ) : null}

      <Field label={t("DashboardIssuance.config.capacityConfig.transferApprovals.approversLabel")}>
        <div className="space-y-2">
          {approvers.map((approver, index) => (
            // Index key: the list is edited in place and never reordered.
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                className={cn(INPUT_CLASS, "flex-1")}
                value={approver}
                placeholder={t(
                  "DashboardIssuance.config.capacityConfig.transferApprovals.approverPlaceholder"
                )}
                disabled={disabled}
                onChange={(event) => {
                  const next = [...approvers];
                  next[index] = event.currentTarget.value;
                  patch({ approvers: next });
                }}
              />
              <button
                type="button"
                disabled={disabled}
                aria-label={t(
                  "DashboardIssuance.config.capacityConfig.transferApprovals.removeApprover"
                )}
                onClick={() => patch({ approvers: approvers.filter((_, i) => i !== index) })}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-default text-tertiary transition-colors hover:text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => patch({ approvers: [...approvers, ""] })}
            className="inline-flex items-center gap-1 text-sm font-medium text-tertiary transition-colors hover:text-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("DashboardIssuance.config.capacityConfig.transferApprovals.addApprover")}
          </button>
          <p className="text-xs text-tertiary">
            {t("DashboardIssuance.config.capacityConfig.transferApprovals.approversHint")}
          </p>
        </div>
      </Field>
    </div>
  );
}

// Drop fields that don't apply to the chosen mode and trim roster entries, so the
// stored config stays minimal and dirty-detection doesn't trip on stale values.
function cleanConfig(
  capKey: CapacityKey,
  config: CapacityConfig | undefined
): CapacityConfig | undefined {
  if (!config) {
    return undefined;
  }
  if (capKey === "restrictTradingHours") {
    const c = config as TradingHoursConfig;
    if (c.schedule === "24_7") {
      return { schedule: "24_7" };
    }
    if (c.schedule === "market_hours") {
      return { schedule: "market_hours", ...(c.timezone ? { timezone: c.timezone } : {}) };
    }
    return {
      schedule: "custom",
      ...(c.days && c.days.length ? { days: c.days } : {}),
      ...(c.open ? { open: c.open } : {}),
      ...(c.close ? { close: c.close } : {}),
      ...(c.timezone ? { timezone: c.timezone } : {}),
    };
  }
  if (capKey === "transferApprovals") {
    const c = config as TransferApprovalsConfig;
    const approvers = (c.approvers ?? []).map((a) => a.trim()).filter(Boolean);
    return {
      rule: c.rule,
      ...(c.rule === "above_amount" && c.amount ? { amount: c.amount } : {}),
      ...(approvers.length ? { approvers } : {}),
    };
  }
  return config;
}
