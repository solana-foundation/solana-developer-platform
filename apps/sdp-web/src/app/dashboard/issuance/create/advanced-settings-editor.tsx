"use client";

import {
  type GroupedSetting,
  getConflictingSettingKeys,
  listSettingsForType,
  type SettingKey,
} from "@sdp/issuance/capabilities";
import type { AssetCategory, ParamFieldSpec } from "@sdp/types";
import {
  BadgeCheck,
  Ban,
  Boxes,
  Briefcase,
  CheckCheck,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Code2,
  Coins,
  ExternalLink,
  FileText,
  Flame,
  Gift,
  HandCoins,
  KeyRound,
  Landmark,
  Lock,
  type LucideIcon,
  Pause,
  Percent,
  Play,
  Scaling,
  ShieldCheck,
  Snowflake,
  Sun,
  TrendingUp,
  Undo2,
  UserCheck,
  UserCog,
  Webhook,
  Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  ACCESS_CONTROL_OPTIONS,
  CAPACITY_META,
  capacityHasConfig,
  summarizeCapacityConfig,
} from "./asset-details-config";
import { CapacityConfigModal } from "./capacity-config-modal";
import type { DeployConfigPreview } from "./draft-mapping";
import {
  type AccessControlMode,
  type AdvancedSettingsDraft,
  CAPACITY_KEYS,
  type CapacityKey,
  type CapacitySelection,
} from "./issuance-draft-wizard.types";
import { JsonCodeBlock } from "./metadata-json";
import { SegmentedControl } from "./segmented-control";
import {
  applyCombo,
  getComboConflict,
  getCombosForCategory,
  isComboActive,
  removeCombo,
  type SettingCombo,
} from "./setting-combos";

type SettingSelection = AdvancedSettingsDraft[string];

const COMBO_ICONS: Record<string, LucideIcon> = {
  regulatedStablecoin: ShieldCheck,
  permissionedStablecoin: Landmark,
  regulatedSecurity: Landmark,
  fundOperations: HandCoins,
  verifiedHolders: BadgeCheck,
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

const ACTION_ICONS: Record<string, LucideIcon> = {
  pause: Pause,
  unpause: Play,
  freeze: Snowflake,
  unfreeze: Sun,
  seize: HandCoins,
  force_burn: Flame,
  update_authority: UserCog,
};

const CAPACITY_ICONS: Record<CapacityKey, LucideIcon> = {
  kyc: UserCheck,
  restrictTradingHours: Clock,
  issueRetireControls: Coins,
  redemptionApprovals: ClipboardCheck,
  investorReporting: FileText,
  transferApprovals: CheckCheck,
};

// Technical labels for capacities whose plain-language name differs from technical.
const CAPACITY_EXPERT_LABELS: Partial<Record<CapacityKey, MessageKey>> = {
  kyc: "DashboardIssuance.config.kycExpert",
  issueRetireControls: "DashboardIssuance.config.issueRetireControlsExpert",
};

// Technical descriptions: token/wallet/mint/burn phrasing reserved for technical mode.
const CAPACITY_EXPERT_DESCRIPTIONS: Partial<Record<CapacityKey, MessageKey>> = {
  kyc: "DashboardIssuance.config.kycDescriptionExpert",
  restrictTradingHours: "DashboardIssuance.config.restrictTradingHoursDescriptionExpert",
  issueRetireControls: "DashboardIssuance.config.issueRetireControlsDescriptionExpert",
  redemptionApprovals: "DashboardIssuance.config.redemptionApprovalsDescriptionExpert",
};

function accessDescriptionKey(mode: AccessControlMode | ""): MessageKey {
  switch (mode) {
    case "allowlist":
      return "DashboardIssuance.config.accessPolicyAllowlistEffect";
    case "blocklist":
      return "DashboardIssuance.config.accessPolicyBlocklistEffect";
    case "disabled":
      return "DashboardIssuance.config.accessPolicyDisabledEffect";
    default:
      return "DashboardIssuance.config.accessPolicyPrompt";
  }
}

interface AdvancedSettingsEditorProps {
  category: AssetCategory | null;
  type: string | null;
  settings: AdvancedSettingsDraft;
  onSettingsChange: (next: AdvancedSettingsDraft) => void;
  // Bulk setter so a preset can flip several at once.
  capacities: Record<CapacityKey, CapacitySelection>;
  onCapacitiesChange: (next: Record<CapacityKey, CapacitySelection>) => void;
  // Reveal Configure button for policies; only the compliance tab opts in.
  allowCapacityConfig?: boolean;
  showErrors?: boolean;
  // Scenario presets are creation-only; the compliance tab opts out. Defaults on.
  showScenarios?: boolean;
  // Locks on-chain settings (deployed token) while keeping off-chain capacities editable.
  settingsReadOnly?: boolean;
  disabled?: boolean;
  // When wired, access control renders inside the permanent section.
  accessControl?: AccessControlMode | "";
  onAccessControlChange?: (mode: AccessControlMode | "") => void;
  accessControlReadOnly?: boolean;
  accessControlDocsHref?: string;
  // Deploy-config preview (technical mode only). Built by parent, not wired here.
  deployConfig?: DeployConfigPreview | null;
  // Collapse the inner grids on the editor's own width (container query) instead
  // of the viewport — for the compliance tab's narrow two-column layout.
  containerResponsive?: boolean;
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
    <span className="inline-flex items-center gap-1 rounded bg-fill-subtle px-1.5 py-0.5 text-[11px] font-medium text-secondary">
      {children}
    </span>
  );
}

function humanizeAction(action: string): string {
  const text = action.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
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

function SettingShell({
  icon,
  checked,
  disabled,
  dimmed,
  locked,
  onToggle,
  label,
  badges,
  actions,
  trailing,
  description,
  children,
}: {
  icon: LucideIcon;
  checked: boolean;
  disabled?: boolean;
  dimmed?: boolean;
  // Permanently-on settings (required or deployed) show a lock, not a disabled
  // checkbox: the box reads "you could change this", the lock reads "fixed".
  locked?: boolean;
  onToggle: (checked: boolean) => void;
  label: string;
  badges?: ReactNode;
  actions?: ReactNode;
  // Right-aligned action, outside the label so clicking it doesn't toggle the checkbox.
  trailing?: ReactNode;
  description: string;
  children?: ReactNode;
}) {
  const t = useTranslations();
  // Locked rows have no control, so the <label> becomes a plain <div> (a label
  // with no associated control is invalid). Padding sits on the row so the whole
  // surface is clickable.
  const rowClassName = cn(
    "flex min-w-0 flex-1 items-center gap-3 p-3",
    disabled || locked ? "cursor-default" : "cursor-pointer",
    dimmed && "opacity-55"
  );
  const rowText = (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="text-sm font-medium text-primary">{label}</span>
        {badges}
      </span>
      <span className="mt-0.5 block text-xs text-tertiary">{description}</span>
      {actions ? <span className="mt-2 flex flex-wrap items-center gap-2.5">{actions}</span> : null}
    </span>
  );

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-surface-raised transition-colors",
        checked ? "border-primary" : "border-border-default"
      )}
    >
      <div className="flex items-center">
        {locked ? (
          <div className={rowClassName}>
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center text-tertiary"
              title={t("DashboardIssuance.config.settingLockedHint")}
            >
              <Lock className="h-3.5 w-3.5" aria-hidden />
            </span>
            <IconTile icon={icon} active={checked} />
            {rowText}
          </div>
        ) : (
          <label className={rowClassName}>
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={(event) => onToggle(event.currentTarget.checked)}
              className="h-4 w-4 shrink-0 accent-primary disabled:opacity-60"
            />
            <IconTile icon={icon} active={checked} />
            {rowText}
          </label>
        )}
        {trailing ? <div className="shrink-0 pr-3 pl-2">{trailing}</div> : null}
      </div>
      {children ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}

export function AdvancedSettingsEditor({
  category,
  type,
  settings,
  onSettingsChange,
  capacities,
  onCapacitiesChange,
  allowCapacityConfig,
  showErrors,
  showScenarios = true,
  settingsReadOnly,
  disabled,
  accessControl,
  onAccessControlChange,
  accessControlReadOnly,
  accessControlDocsHref,
  deployConfig,
  containerResponsive,
}: AdvancedSettingsEditorProps) {
  const t = useTranslations();
  const [showTechnical, setShowTechnical] = useState(false);
  const [showDeployConfig, setShowDeployConfig] = useState(false);
  const [configuringCapacity, setConfiguringCapacity] = useState<CapacityKey | null>(null);

  if (!category || !type) {
    return null;
  }

  const permanent = listSettingsForType(category, type);
  // Once deployed, an extension not baked into the mint can't be added — show
  // only the ones in effect (required or selected at deploy), not dead rows.
  const visiblePermanent = settingsReadOnly
    ? permanent.filter(
        (entry) => entry.availability === "locked" || settings[entry.key] !== undefined
      )
    : permanent;

  const access = accessControl ?? "";
  const combos = getCombosForCategory(category);
  const activeCombos = combos.filter((combo) => isComboActive(combo, settings, capacities, access));
  const toggleCombo = (combo: SettingCombo, enabled: boolean) => {
    const next = enabled
      ? applyCombo(combo, settings, capacities, access)
      : removeCombo(
          combo,
          settings,
          capacities,
          activeCombos.filter((other) => other.key !== combo.key),
          access
        );
    onSettingsChange(next.settings);
    onCapacitiesChange(next.capacities);
    onAccessControlChange?.(next.accessControl);
  };

  const setEnabled = (entry: GroupedSetting, enabled: boolean) => {
    const next = { ...settings };
    if (enabled) {
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
    <div
      className={cn(
        "rounded-2xl border border-border-default bg-surface-raised p-5",
        // Query container for the container-responsive inner grids.
        containerResponsive && "@container"
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-base font-medium text-primary">
            {t("DashboardIssuance.config.advancedSettingsTitle")}
          </p>
        </div>
        <button
          type="button"
          aria-pressed={showTechnical}
          onClick={() => setShowTechnical((value) => !value)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border-default px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-fill-subtle"
        >
          {showTechnical ? (
            <Wrench className="h-3.5 w-3.5" />
          ) : (
            <Briefcase className="h-3.5 w-3.5" />
          )}
          {t("DashboardIssuance.config.showTechnicalDetail")}
        </button>
      </div>

      {/* Quick-fill presets — creation-only, and hidden once on-chain settings are locked. */}
      {showScenarios && !settingsReadOnly && combos.length > 0 ? (
        <section className="mt-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-secondary">
            {t("DashboardIssuance.config.quickFillLabel")}
          </p>
          <p className="mt-0.5 text-xs text-tertiary">
            {t("DashboardIssuance.config.quickFillHint")}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {combos.map((combo) => {
              const active = isComboActive(combo, settings, capacities, access);
              const conflict = active ? null : getComboConflict(combo, settings);
              const blocked = conflict !== null;
              const Icon = COMBO_ICONS[combo.key] ?? Boxes;
              return (
                <button
                  key={combo.key}
                  type="button"
                  disabled={disabled || blocked}
                  aria-pressed={active}
                  onClick={() => toggleCombo(combo, !active)}
                  title={
                    conflict
                      ? `${t("DashboardIssuance.config.settingConflictsWith")} ${t(conflict.withLabelKey as MessageKey)}`
                      : undefined
                  }
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    active
                      ? "border-primary text-primary"
                      : "border-border-default text-tertiary hover:text-primary",
                    blocked && "cursor-not-allowed opacity-50"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(combo.labelKey as MessageKey)}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Permanent · on-chain, set at creation --------------------------- */}
      <section className="mt-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-secondary">
              {t(
                showTechnical
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
          </div>
          {showTechnical && deployConfig ? (
            <button
              type="button"
              aria-pressed={showDeployConfig}
              onClick={() => setShowDeployConfig((value) => !value)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border-default px-3 py-1 text-xs font-medium transition-colors",
                showDeployConfig
                  ? "bg-fill-subtle text-primary"
                  : "text-tertiary hover:text-primary"
              )}
            >
              <Code2 className="h-3.5 w-3.5" />
              {t("DashboardIssuance.config.deployPreview")}
            </button>
          ) : null}
        </div>

        {/* Deploy payload preview in technical mode. */}
        {showTechnical && showDeployConfig && deployConfig ? (
          <div className="mt-3">
            <p className="mb-2 text-xs text-tertiary">
              {t("DashboardIssuance.assetDetails.deployConfigAuthorityNote")}
            </p>
            <JsonCodeBlock value={deployConfig} />
          </div>
        ) : null}

        <div className="mt-3 grid gap-2.5">
          {onAccessControlChange ? (
            <AccessControlRow
              mode={accessControl ?? ""}
              onChange={onAccessControlChange}
              disabled={disabled || accessControlReadOnly}
              showTechnical={showTechnical}
              docsHref={accessControlDocsHref}
            />
          ) : null}
          {visiblePermanent.map((entry) => (
            <PermanentRow
              key={entry.key}
              entry={entry}
              selection={settings[entry.key]}
              showTechnical={showTechnical}
              showErrors={showErrors}
              disabled={disabled || settingsReadOnly}
              readOnly={settingsReadOnly}
              conflictWith={conflictBlocker(entry.key)}
              containerResponsive={containerResponsive}
              onToggle={(enabled) => setEnabled(entry, enabled)}
              onParam={setParam}
            />
          ))}
        </div>
      </section>

      {/* Ongoing · off-chain, changeable anytime ------------------------- */}
      <section className="mt-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-secondary">
          {t(
            showTechnical
              ? "DashboardIssuance.config.settingsOffchainTitle"
              : "DashboardIssuance.config.settingsOngoingTitle"
          )}
        </p>
        <p className="mt-0.5 text-xs text-tertiary">
          {t(
            allowCapacityConfig
              ? "DashboardIssuance.config.settingsOngoingSubtitle"
              : "DashboardIssuance.config.settingsOngoingSubtitleDraft"
          )}
        </p>
        <div
          className={cn(
            "mt-3 grid gap-2.5",
            // Two up only when there's room (container width vs. viewport).
            containerResponsive ? "@2xl:grid-cols-2" : "sm:grid-cols-2"
          )}
        >
          {CAPACITY_KEYS.map((key) => {
            const selection = capacities[key];
            const configurable = capacityHasConfig(key);
            return (
              <CapacityRow
                key={key}
                capKey={key}
                checked={selection.enabled}
                disabled={disabled}
                showTechnical={showTechnical}
                configurable={configurable}
                allowConfig={allowCapacityConfig}
                summary={configurable ? summarizeCapacityConfig(key, selection.config, t) : null}
                onToggle={(checked) =>
                  onCapacitiesChange({
                    ...capacities,
                    [key]: { ...selection, enabled: checked },
                  })
                }
                onConfigure={() => setConfiguringCapacity(key)}
              />
            );
          })}
        </div>
      </section>

      <CapacityConfigModal
        capKey={configuringCapacity}
        config={configuringCapacity ? capacities[configuringCapacity].config : undefined}
        disabled={disabled}
        onClose={() => setConfiguringCapacity(null)}
        onSave={(config) => {
          if (!configuringCapacity) {
            return;
          }
          onCapacitiesChange({
            ...capacities,
            [configuringCapacity]: { ...capacities[configuringCapacity], config },
          });
        }}
      />
    </div>
  );
}

// 3-way mode (allowlist/blocklist/disabled) rendered as segmented control.
function AccessControlRow({
  mode,
  onChange,
  disabled,
  showTechnical,
  docsHref,
}: {
  mode: AccessControlMode | "";
  onChange: (mode: AccessControlMode | "") => void;
  disabled?: boolean;
  showTechnical?: boolean;
  docsHref?: string;
}) {
  const t = useTranslations();
  // "Gated" = a holder restriction is in effect (allowlist or blocklist).
  const gated = mode === "allowlist" || mode === "blocklist";
  return (
    <div
      className={cn(
        "rounded-xl border bg-surface-raised p-3 transition-colors",
        gated ? "border-primary" : "border-border-default"
      )}
    >
      <div className={cn("flex items-start gap-3", disabled && "opacity-55")}>
        <IconTile icon={ShieldCheck} active={gated} />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium text-primary">
            {t("DashboardIssuance.compliance.accessControl")}
          </span>
          <span className="mt-0.5 block text-xs text-tertiary">
            {t(accessDescriptionKey(mode))}
          </span>
        </div>
      </div>
      <SegmentedControl
        className="mt-3"
        ariaLabel={t("DashboardIssuance.compliance.accessControl")}
        value={mode}
        onChange={(value) => onChange(value as AccessControlMode | "")}
        disabled={disabled}
        optionClassName="py-1"
        selectedClassName="bg-primary text-on-primary"
        options={ACCESS_CONTROL_OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
        }))}
      />
      {docsHref ? (
        <div className="mt-2.5">
          <a
            href={docsHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-tertiary underline-offset-2 transition-colors hover:text-primary hover:underline"
          >
            {t("DashboardIssuance.assetDetails.learnLists")}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : null}
      {showTechnical ? (
        <p className="mt-2 border-t border-border-subtle pt-2 text-[11px] leading-relaxed text-tertiary">
          {t("DashboardIssuance.config.accessPolicyTechnical")}
        </p>
      ) : null}
    </div>
  );
}

function PermanentRow({
  entry,
  selection,
  showTechnical,
  showErrors,
  disabled,
  readOnly,
  conflictWith,
  containerResponsive,
  onToggle,
  onParam,
}: {
  entry: GroupedSetting;
  selection: SettingSelection | undefined;
  showTechnical?: boolean;
  showErrors?: boolean;
  disabled?: boolean;
  // Deployed token: on-chain settings are read-only, so an enabled one locks.
  readOnly?: boolean;
  conflictWith?: string;
  containerResponsive?: boolean;
  onToggle: (enabled: boolean) => void;
  onParam: (key: string, paramKey: string, value: string) => void;
}) {
  const t = useTranslations();
  const { key, setting, availability } = entry;
  const isLocked = availability === "locked";
  const checked = isLocked || selection !== undefined;
  const blocked = !checked && conflictWith !== undefined;
  // Required always locks; a read-only setting locks only when it's actually on.
  const locked = isLocked || Boolean(readOnly && checked);
  const params = setting.params ?? [];

  return (
    <SettingShell
      icon={SETTING_ICONS[key] ?? KeyRound}
      checked={checked}
      disabled={disabled || isLocked || blocked}
      dimmed={blocked}
      locked={locked}
      onToggle={onToggle}
      label={showTechnical ? extensionTitle(setting.extensions) : t(setting.labelKey as MessageKey)}
      description={t(setting.descriptionKey as MessageKey)}
      badges={
        isLocked ? (
          <Pill>{t("DashboardIssuance.config.settingRequired")}</Pill>
        ) : availability === "recommended" ? (
          <Pill>{t("DashboardIssuance.config.settingRecommended")}</Pill>
        ) : null
      }
      actions={
        showTechnical && setting.actions.length > 0
          ? setting.actions.map((action) => {
              const ActionIcon = ACTION_ICONS[action];
              return (
                <Tag key={action}>
                  {ActionIcon ? <ActionIcon className="h-3 w-3 text-tertiary" /> : null}
                  {humanizeAction(action)}
                </Tag>
              );
            })
          : null
      }
    >
      {/* Render conflict or params, but not both (footer adds phantom padding otherwise). */}
      {blocked ? (
        <p className="flex flex-wrap items-center gap-1.5 border-t border-border-subtle pt-2 text-[11px] text-tertiary">
          {t("DashboardIssuance.config.settingConflictsWith")}
          <Tag>{conflictWith}</Tag>
        </p>
      ) : checked && params.length > 0 ? (
        <div
          className={cn(
            "grid items-start gap-x-3 gap-y-2 border-t border-border-subtle pt-2.5",
            containerResponsive ? "@2xl:grid-cols-2" : "sm:grid-cols-2"
          )}
        >
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
    </SettingShell>
  );
}

function CapacityRow({
  capKey,
  checked,
  disabled,
  showTechnical,
  configurable,
  allowConfig,
  summary,
  onToggle,
  onConfigure,
}: {
  capKey: CapacityKey;
  checked: boolean;
  disabled?: boolean;
  showTechnical?: boolean;
  configurable?: boolean;
  allowConfig?: boolean;
  summary?: string | null;
  onToggle: (checked: boolean) => void;
  onConfigure?: () => void;
}) {
  const t = useTranslations();
  const meta = CAPACITY_META[capKey];
  const expertLabel = CAPACITY_EXPERT_LABELS[capKey];
  const expertDescription = CAPACITY_EXPERT_DESCRIPTIONS[capKey];
  // Config affordance appears only when the capacity is on and configurable here.
  const showConfig = Boolean(checked && configurable && allowConfig);
  return (
    <SettingShell
      icon={CAPACITY_ICONS[capKey]}
      checked={checked}
      disabled={disabled}
      onToggle={onToggle}
      label={showTechnical && expertLabel ? t(expertLabel) : t(meta.labelKey)}
      description={
        showTechnical && expertDescription ? t(expertDescription) : t(meta.descriptionKey)
      }
      badges={
        showConfig ? (
          <Pill>{summary ?? t("DashboardIssuance.config.capacityConfig.notConfigured")}</Pill>
        ) : null
      }
      trailing={
        showConfig ? (
          <button
            type="button"
            onClick={onConfigure}
            disabled={disabled}
            className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-primary transition-colors hover:underline disabled:pointer-events-none disabled:opacity-50"
          >
            {t("DashboardIssuance.config.capacityConfig.configure")}
            <ChevronRight className="h-3 w-3" />
          </button>
        ) : null
      }
    />
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
