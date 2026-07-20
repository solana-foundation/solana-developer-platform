"use client";

import {
  type GroupedSetting,
  getConflictingSettingKeys,
  listSettingsForType,
  type SettingKey,
} from "@sdp/issuance/capabilities";
import type { AssetCategory, ParamFieldSpec } from "@sdp/types";
import {
  Ban,
  Boxes,
  Briefcase,
  CheckCheck,
  ClipboardCheck,
  Clock,
  Coins,
  FileText,
  Gift,
  GraduationCap,
  KeyRound,
  Landmark,
  ListChecks,
  Lock,
  type LucideIcon,
  Percent,
  Scaling,
  ShieldCheck,
  Snowflake,
  TrendingUp,
  Undo2,
  UserCheck,
  Users,
  Webhook,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { CAPACITY_META } from "./asset-details-config";
import {
  type AdvancedSettingsDraft,
  CAPACITY_KEYS,
  type CapacityKey,
} from "./issuance-draft-wizard.types";
import {
  applyCombo,
  comboItemLabelKeys,
  getComboConflict,
  getCombosForCategory,
  isComboActive,
  removeCombo,
  type SettingCombo,
} from "./setting-combos";

type Mode = "basic" | "detailed" | "expert";
type SettingSelection = AdvancedSettingsDraft[string];

const COMBO_ICONS: Record<string, LucideIcon> = {
  regulatedStablecoin: ShieldCheck,
  publicSecurityOffering: Landmark,
  privateFund: Users,
  controlledAsset: KeyRound,
  loyaltyRewards: Gift,
  yieldNote: TrendingUp,
  revenueShare: Percent,
  gatedAccess: Lock,
};

// Icons keep the list scannable (SDP reserves colour for status).
const SETTING_ICONS: Record<string, LucideIcon> = {
  freezeTransfers: Snowflake,
  permanentDelegate: Undo2,
  transferFee: Percent,
  interestBearing: TrendingUp,
  scaledUiAmount: Scaling,
  nonTransferable: Ban,
  transferHook: Webhook,
};

const CAPACITY_ICONS: Record<CapacityKey, LucideIcon> = {
  kyc: UserCheck,
  restrictTradingHours: Clock,
  issueRetireControls: Coins,
  redemptionApprovals: ClipboardCheck,
  investorReporting: FileText,
  transferApprovals: CheckCheck,
};

// Expert view uses technical names when they differ from manager-facing labels.
const CAPACITY_EXPERT_LABELS: Partial<Record<CapacityKey, MessageKey>> = {
  kyc: "DashboardIssuance.config.kycExpert",
  issueRetireControls: "DashboardIssuance.config.issueRetireControlsExpert",
};

interface AdvancedSettingsEditorProps {
  category: AssetCategory | null;
  type: string | null;
  // On-chain, extension-backed settings (permanent once deployed).
  settings: AdvancedSettingsDraft;
  onSettingsChange: (next: AdvancedSettingsDraft) => void;
  // Off-chain compliance capacities (changeable after launch). Bulk setter so a
  // combo can flip several at once in a single draft update.
  capacities: Record<CapacityKey, boolean>;
  onCapacitiesChange: (next: Record<CapacityKey, boolean>) => void;
  // Reveal required-but-empty param errors (after a failed Continue attempt).
  showErrors?: boolean;
  // Lock the on-chain settings (a deployed token: extensions are immutable) while
  // leaving the off-chain capacities editable. Also hides the Basic preset view,
  // whose combos bundle on-chain settings that can no longer change.
  settingsReadOnly?: boolean;
  disabled?: boolean;
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-fill-subtle px-2 py-0.5 text-[11px] font-medium text-secondary">
      {children}
    </span>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-fill-subtle px-1.5 py-0.5 text-[11px] font-medium text-secondary">
      {children}
    </span>
  );
}

function humanizeExtension(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function extensionTitle(extensions: readonly string[]): string {
  const text = extensions.map(humanizeExtension).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function IconTile({ icon: Icon, active }: { icon: LucideIcon; active: boolean }) {
  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle",
        active ? "text-primary" : "text-tertiary"
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </span>
  );
}

// Card shell with checkbox, icon, label, and footer for params/expert info.
function SettingShell({
  icon,
  checked,
  disabled,
  dimmed,
  onToggle,
  label,
  badges,
  description,
  children,
}: {
  icon: LucideIcon;
  checked: boolean;
  disabled?: boolean;
  dimmed?: boolean;
  onToggle: (checked: boolean) => void;
  label: string;
  badges?: ReactNode;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-white p-3 transition-colors",
        checked ? "border-primary" : "border-border-default"
      )}
    >
      <label
        className={cn(
          "flex items-center gap-3",
          disabled ? "cursor-default" : "cursor-pointer",
          dimmed && "opacity-55"
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onToggle(event.currentTarget.checked)}
          className="h-4 w-4 shrink-0 accent-primary disabled:opacity-60"
        />
        <IconTile icon={icon} active={checked} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-primary">{label}</span>
            {badges}
          </span>
          <span className="mt-0.5 block text-xs text-tertiary">{description}</span>
        </span>
      </label>
      {children}
    </div>
  );
}

// Three views: Basic (curated presets), Detailed (individual settings), Expert (with extension names).
export function AdvancedSettingsEditor({
  category,
  type,
  settings,
  onSettingsChange,
  capacities,
  onCapacitiesChange,
  showErrors,
  settingsReadOnly,
  disabled,
}: AdvancedSettingsEditorProps) {
  const t = useTranslations();
  const [mode, setMode] = useState<Mode>(settingsReadOnly ? "detailed" : "basic");

  if (!category || !type) {
    return null;
  }

  const permanent = listSettingsForType(category, type);
  const expert = mode === "expert";
  // Deployed tokens can't use Basic mode (its combos require writable on-chain settings).
  const availableModes: Mode[] = settingsReadOnly
    ? ["detailed", "expert"]
    : ["basic", "detailed", "expert"];

  const combos = getCombosForCategory(category);
  const activeCombos = combos.filter((combo) => isComboActive(combo, settings, capacities));
  const toggleCombo = (combo: SettingCombo, enabled: boolean) => {
    const next = enabled
      ? applyCombo(combo, settings, capacities)
      : removeCombo(
          combo,
          settings,
          capacities,
          activeCombos.filter((other) => other.key !== combo.key)
        );
    onSettingsChange(next.settings);
    onCapacitiesChange(next.capacities);
  };

  // Detect when selections don't match any preset (show custom selection note in Basic view).
  const lockedKeys = new Set(
    permanent.filter((entry) => entry.availability === "locked").map((entry) => entry.key)
  );
  const hasCustomSelection =
    activeCombos.length === 0 &&
    (Object.keys(settings).some((key) => !lockedKeys.has(key as SettingKey)) ||
      CAPACITY_KEYS.some((key) => capacities[key]));

  const setEnabled = (entry: GroupedSetting, enabled: boolean) => {
    const next = { ...settings };
    if (enabled) {
      // Populate default param values on enable.
      const params: Record<string, string> = {};
      for (const param of entry.setting.params ?? []) {
        if (param.defaultValue !== undefined) {
          params[param.key] = String(param.defaultValue);
        }
      }
      next[entry.key] = settings[entry.key] ?? (Object.keys(params).length ? { params } : {});
    } else {
      delete next[entry.key];
    }
    onSettingsChange(next);
  };

  const setParam = (key: string, paramKey: string, paramValue: string) => {
    const current = settings[key] ?? {};
    onSettingsChange({
      ...settings,
      [key]: { ...current, params: { ...current.params, [paramKey]: paramValue } },
    });
  };

  const selectedKeys = permanent
    .filter((entry) => entry.availability === "locked" || settings[entry.key] !== undefined)
    .map((entry) => entry.key);
  const labelByKey = new Map<string, string>(
    permanent.map((entry) => [entry.key, t(entry.setting.labelKey as MessageKey)])
  );
  const settingByKey = new Map(permanent.map((entry) => [entry.key, entry.setting]));
  // Return the label of any enabled setting that conflicts with this key, if any.
  const conflictBlocker = (key: SettingKey): string | undefined => {
    if (settings[key] !== undefined) {
      return undefined;
    }
    const conflicts = getConflictingSettingKeys(key);
    const blocker = selectedKeys.find(
      (selected) => selected !== key && conflicts.includes(selected)
    );
    return blocker ? labelByKey.get(blocker) : undefined;
  };

  return (
    <div className="rounded-2xl border border-border-default bg-white p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-base font-medium text-primary">
            {t("DashboardIssuance.config.advancedSettingsTitle")}
          </p>
        </div>
        <div
          className="flex w-full shrink-0 rounded-lg border border-border-default bg-fill-subtle p-0.5 sm:inline-flex sm:w-auto"
          role="tablist"
          aria-label={t("DashboardIssuance.config.settingsModeAria")}
        >
          {availableModes.map((m) => {
            const Icon = m === "basic" ? Briefcase : m === "detailed" ? ListChecks : GraduationCap;
            const labelKey: MessageKey =
              m === "basic"
                ? "DashboardIssuance.config.settingsModeBasic"
                : m === "detailed"
                  ? "DashboardIssuance.config.settingsModeDetailed"
                  : "DashboardIssuance.config.settingsModeExpert";
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors sm:flex-none",
                  mode === m ? "bg-white text-primary" : "text-tertiary hover:text-primary"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {mode === "basic" ? (
        <section className="mt-5">
          {hasCustomSelection ? (
            <p className="mt-3 rounded-lg border border-border-default bg-fill-subtle px-3 py-2 text-[11px] text-secondary">
              {t("DashboardIssuance.config.comboCustomSelection")}
            </p>
          ) : null}
          <div className="mt-3 grid gap-2.5">
            {combos.map((combo) => {
              const active = isComboActive(combo, settings, capacities);
              const conflict = active ? null : getComboConflict(combo, settings);
              const blocked = conflict !== null;
              const includeKeys = comboItemLabelKeys(combo);
              // Show required param fields inline for active combos.
              const paramRows = active
                ? combo.settings.flatMap((sk) =>
                    (settingByKey.get(sk)?.params ?? [])
                      .filter((param) => param.required)
                      .map((param) => ({ settingKey: sk, param }))
                  )
                : [];
              return (
                <SettingShell
                  key={combo.key}
                  icon={COMBO_ICONS[combo.key] ?? Boxes}
                  checked={active}
                  disabled={disabled || blocked}
                  dimmed={blocked}
                  onToggle={(checked) => toggleCombo(combo, checked)}
                  label={t(combo.labelKey as MessageKey)}
                  description={t(combo.descriptionKey as MessageKey)}
                >
                  {conflict ? (
                    <p className="mt-2 border-t border-border-subtle pt-2 text-[11px] leading-relaxed text-tertiary">
                      {t("DashboardIssuance.config.settingConflictsWith")}{" "}
                      <Tag>{t(conflict.withLabelKey as MessageKey)}</Tag> —{" "}
                      {t(conflict.reasonKey as MessageKey)}
                    </p>
                  ) : (
                    <>
                      {includeKeys.length > 0 ? (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border-subtle pt-2">
                          {includeKeys.map((key) => (
                            <Tag key={key}>{t(key as MessageKey)}</Tag>
                          ))}
                        </div>
                      ) : null}
                      {paramRows.length > 0 ? (
                        <div className="mt-2.5 grid items-start gap-x-3 gap-y-2 border-t border-border-subtle pt-2.5 sm:grid-cols-2">
                          {paramRows.map(({ settingKey: sk, param }) => (
                            <ParamField
                              key={`${sk}-${param.key}`}
                              param={param}
                              settingKey={sk}
                              value={settings[sk]?.params?.[param.key] ?? ""}
                              invalid={
                                !!showErrors &&
                                (settings[sk]?.params?.[param.key] ?? "").trim() === ""
                              }
                              disabled={disabled}
                              onChange={(value) => setParam(sk, param.key, value)}
                            />
                          ))}
                        </div>
                      ) : null}
                    </>
                  )}
                </SettingShell>
              );
            })}
          </div>
        </section>
      ) : (
        <>
          <section className="mt-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-secondary">
              {t(
                expert
                  ? "DashboardIssuance.config.settingsOnchainTitle"
                  : "DashboardIssuance.config.settingsPermanentTitle"
              )}
            </p>
            <p className="mt-0.5 text-xs text-tertiary">
              {t(
                settingsReadOnly
                  ? "DashboardIssuance.config.settingsPermanentLockedSubtitle"
                  : "DashboardIssuance.config.settingsPermanentSubtitle"
              )}
            </p>
            <div className="mt-3 grid gap-2.5">
              {permanent.map((entry) => (
                <PermanentRow
                  key={entry.key}
                  entry={entry}
                  selection={settings[entry.key]}
                  expert={expert}
                  showErrors={showErrors}
                  disabled={disabled || settingsReadOnly}
                  conflictWith={conflictBlocker(entry.key)}
                  onToggle={(enabled) => setEnabled(entry, enabled)}
                  onParam={setParam}
                />
              ))}
            </div>
          </section>

          <section className="mt-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-secondary">
              {t(
                expert
                  ? "DashboardIssuance.config.settingsOffchainTitle"
                  : "DashboardIssuance.config.settingsOngoingTitle"
              )}
            </p>
            <p className="mt-0.5 text-xs text-tertiary">
              {t("DashboardIssuance.config.settingsOngoingSubtitle")}
            </p>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              {CAPACITY_KEYS.map((key) => {
                const meta = CAPACITY_META[key];
                const expertLabel = CAPACITY_EXPERT_LABELS[key];
                return (
                  <SettingShell
                    key={key}
                    icon={CAPACITY_ICONS[key]}
                    checked={capacities[key]}
                    disabled={disabled}
                    onToggle={(checked) => onCapacitiesChange({ ...capacities, [key]: checked })}
                    label={expert && expertLabel ? t(expertLabel) : t(meta.labelKey)}
                    description={t(meta.descriptionKey)}
                  />
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// Locked settings are checked and non-deselectable; expert mode reveals mechanics.
function PermanentRow({
  entry,
  selection,
  expert,
  showErrors,
  disabled,
  conflictWith,
  onToggle,
  onParam,
}: {
  entry: GroupedSetting;
  selection: SettingSelection | undefined;
  expert: boolean;
  showErrors?: boolean;
  disabled?: boolean;
  conflictWith?: string;
  onToggle: (enabled: boolean) => void;
  onParam: (key: string, paramKey: string, value: string) => void;
}) {
  const t = useTranslations();
  const { key, setting, availability } = entry;
  const isLocked = availability === "locked";
  const checked = isLocked || selection !== undefined;
  const blocked = !checked && conflictWith !== undefined;
  const params = setting.params ?? [];

  return (
    <SettingShell
      icon={SETTING_ICONS[key] ?? KeyRound}
      checked={checked}
      disabled={disabled || isLocked || blocked}
      dimmed={blocked}
      onToggle={onToggle}
      label={expert ? extensionTitle(setting.extensions) : t(setting.labelKey as MessageKey)}
      description={t(setting.descriptionKey as MessageKey)}
      badges={
        isLocked ? (
          <Pill>{t("DashboardIssuance.config.settingRequired")}</Pill>
        ) : availability === "recommended" ? (
          <Pill>{t("DashboardIssuance.config.settingRecommended")}</Pill>
        ) : null
      }
    >
      {blocked ? (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border-subtle pt-2 text-[11px] text-tertiary">
          {t("DashboardIssuance.config.settingConflictsWith")}
          <Tag>{conflictWith}</Tag>
        </p>
      ) : null}
      {checked && params.length > 0 ? (
        <div className="mt-2.5 grid items-start gap-x-3 gap-y-2 border-t border-border-subtle pt-2.5 sm:grid-cols-2">
          {params.map((param) => (
            <ParamField
              key={param.key}
              param={param}
              settingKey={key}
              value={selection?.params?.[param.key] ?? ""}
              invalid={
                !!showErrors &&
                !!param.required &&
                (selection?.params?.[param.key] ?? "").trim() === ""
              }
              disabled={disabled}
              onChange={(value) => onParam(key, param.key, value)}
            />
          ))}
        </div>
      ) : null}

      {expert && setting.actions.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border-subtle pt-2 text-[11px]">
          <span className="text-tertiary">
            {t("DashboardIssuance.config.settingExpertUnlocks")}
          </span>
          {setting.actions.map((action) => (
            <Tag key={action}>{action}</Tag>
          ))}
        </div>
      ) : null}
    </SettingShell>
  );
}

function ParamField({
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
    "rounded-lg border bg-white px-3 py-2 text-sm text-primary outline-none transition-colors",
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
