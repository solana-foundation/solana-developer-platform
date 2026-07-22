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
import {
  applyCombo,
  getComboConflict,
  getCombosForCategory,
  isComboActive,
  removeCombo,
  type SettingCombo,
} from "./setting-combos";

type SettingSelection = AdvancedSettingsDraft[string];

// Icons for the quick-fill scenario chips.
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

// SDP action identifiers → an icon for the technical-mode action badges.
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

// Technical-mode labels for the off-chain policies, matching the old Expert view.
// Only the capacities whose plain-language name differs from their technical name
// override; the rest keep their manager-facing label.
const CAPACITY_EXPERT_LABELS: Partial<Record<CapacityKey, MessageKey>> = {
  kyc: "DashboardIssuance.config.kycExpert",
  issueRetireControls: "DashboardIssuance.config.issueRetireControlsExpert",
};

// The manager-facing effect line for each access-control mode. accessControl is a
// standalone field (a 3-way mode, template-defaulted, immutable at deploy) — it's
// surfaced here as a control alongside the settings, but its plumbing is unchanged.
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
  // On-chain, extension-backed settings (permanent once deployed).
  settings: AdvancedSettingsDraft;
  onSettingsChange: (next: AdvancedSettingsDraft) => void;
  // Off-chain compliance capacities (changeable after launch). Bulk setter so a
  // preset can flip several at once in a single draft update.
  capacities: Record<CapacityKey, CapacitySelection>;
  onCapacitiesChange: (next: Record<CapacityKey, CapacitySelection>) => void;
  // Enable the per-policy Configure affordance (opens the config modal). The step
  // wizard leaves this off — capacities are declaration-only there; the compliance
  // tab opts in so operators can configure how each enabled policy works.
  allowCapacityConfig?: boolean;
  // Reveal required-but-empty param errors (after a failed Continue attempt).
  showErrors?: boolean;
  // Lock the on-chain settings (a deployed token: extensions are immutable) while
  // leaving the off-chain capacities editable. Also hides the quick-fill presets,
  // whose scenarios bundle on-chain settings that can no longer change.
  settingsReadOnly?: boolean;
  disabled?: boolean;
  // Access-control (allowlist/blocklist/disabled) surfaced as the first on-chain
  // control. OPTIONAL: only the create wizard opts in (passing onAccessControlChange
  // moves the standalone accessControl card into this editor). The post-deploy
  // compliance tab omits these and keeps its own accessControl card unchanged —
  // it could opt in later via onAccessControlChange + accessControlReadOnly.
  accessControl?: AccessControlMode | "";
  onAccessControlChange?: (mode: AccessControlMode | "") => void;
  accessControlReadOnly?: boolean;
  accessControlDocsHref?: string;
  // Resolved deploy-config preview (what the settings compile to on-chain). OPTIONAL:
  // when provided, technical mode reveals it as a JSON section at the bottom. Built by
  // the parent (buildDeployConfigPreview) so the editor stays free of resolver wiring.
  deployConfig?: DeployConfigPreview | null;
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

// Raw SDP action identifiers (e.g. "force_burn") read as underscore_case; soften
// them to capitalized spaced words for the badges ("force_burn" → "Force burn").
function humanizeAction(action: string): string {
  const text = action.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Token-2022 extension names are camelCase (e.g. "permanentDelegate"); in
// technical mode the row title shows the real extension name in human-friendly
// spaced words rather than the manager-facing label.
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

// Card shell with checkbox, icon, label, and footer for params/technical detail.
function SettingShell({
  icon,
  checked,
  disabled,
  dimmed,
  onToggle,
  label,
  badges,
  actions,
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
  actions?: ReactNode;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-surface-raised transition-colors",
        checked ? "border-primary" : "border-border-default"
      )}
    >
      <label
        className={cn(
          // Padding lives on the label (not the card) so the entire card surface —
          // including its edges — is clickable and shows the pointer cursor. Center
          // the icon/checkbox against the full content (title + description + any
          // actions row) so every row reads as vertically balanced.
          "flex items-center gap-3 p-3",
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
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="text-sm font-medium text-primary">{label}</span>
            {badges}
          </span>
          <span className="mt-0.5 block text-xs text-tertiary">{description}</span>
          {actions ? (
            <span className="mt-2 flex flex-wrap items-center gap-2.5">{actions}</span>
          ) : null}
        </span>
      </label>
      {/* Params / conflict note sit outside the label (so clicking an input never
          toggles the checkbox) and carry their own padding since the card has none. */}
      {children ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}

// One transparent controls view: a unified list of manager controls (access
// control + on-chain settings + off-chain capacities), each showing an honest
// "what this does" line. A "Show technical detail" toggle reveals the Token-2022
// extensions and SDP actions behind each row; presets are a quick-fill affordance.
export function AdvancedSettingsEditor({
  category,
  type,
  settings,
  onSettingsChange,
  capacities,
  onCapacitiesChange,
  allowCapacityConfig,
  showErrors,
  settingsReadOnly,
  disabled,
  accessControl,
  onAccessControlChange,
  accessControlReadOnly,
  accessControlDocsHref,
  deployConfig,
}: AdvancedSettingsEditorProps) {
  const t = useTranslations();
  const [showTechnical, setShowTechnical] = useState(false);
  const [showDeployConfig, setShowDeployConfig] = useState(false);
  // The capacity whose config modal is open (null = closed).
  const [configuringCapacity, setConfiguringCapacity] = useState<CapacityKey | null>(null);

  if (!category || !type) {
    return null;
  }

  const permanent = listSettingsForType(category, type);

  // Presets (quick-fill). Toggling one bulk-flips its settings + capacities and, for
  // verified-holder scenarios, its access-control mode.
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
    <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
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
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border-default px-3 py-1 text-xs font-medium transition-colors",
            showTechnical ? "bg-fill-subtle text-primary" : "text-tertiary hover:text-primary"
          )}
        >
          {showTechnical ? (
            <Wrench className="h-3.5 w-3.5" />
          ) : (
            <Briefcase className="h-3.5 w-3.5" />
          )}
          {t("DashboardIssuance.config.showTechnicalDetail")}
        </button>
      </div>

      {/* Quick-fill presets — pre-select controls from a scenario. Hidden once the
          on-chain settings are locked (a deployed token). */}
      {!settingsReadOnly && combos.length > 0 ? (
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

        {/* Deploy payload preview · what these on-chain settings compile to.
            Shown right under the toggle, technical mode only. */}
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
          {permanent.map((entry) => (
            <PermanentRow
              key={entry.key}
              entry={entry}
              selection={settings[entry.key]}
              showTechnical={showTechnical}
              showErrors={showErrors}
              disabled={disabled || settingsReadOnly}
              conflictWith={conflictBlocker(entry.key)}
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
          {t("DashboardIssuance.config.settingsOngoingSubtitle")}
        </p>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
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
                summary={
                  configurable ? summarizeCapacityConfig(key, selection.config, t) : null
                }
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

// The access-control policy, surfaced as the first on-chain control. Unlike the
// other rows it's a 3-way mode (allowlist / blocklist / disabled), so it renders a
// segmented control rather than a checkbox.
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
      <div
        className="mt-3 flex rounded-lg border border-border-default bg-fill-subtle p-0.5"
        role="tablist"
        aria-label={t("DashboardIssuance.compliance.accessControl")}
      >
        {ACCESS_CONTROL_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={mode === option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex flex-1 items-center justify-center rounded-md px-3 py-1 text-xs font-medium transition-colors",
              mode === option.value
                ? "bg-primary text-on-primary"
                : "text-tertiary hover:text-primary",
              disabled && "cursor-not-allowed"
            )}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>
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

// A single on-chain setting. Locked settings are checked and non-deselectable;
// the technical toggle reveals the Token-2022 extension(s) and SDP actions.
function PermanentRow({
  entry,
  selection,
  showTechnical,
  showErrors,
  disabled,
  conflictWith,
  onToggle,
  onParam,
}: {
  entry: GroupedSetting;
  selection: SettingSelection | undefined;
  showTechnical?: boolean;
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
      {/* Single node (or null) so the shell's footer wrapper isn't rendered — and
          doesn't add phantom bottom padding — when there's neither a conflict nor
          params. blocked (needs !checked) and params (needs checked) are exclusive. */}
      {blocked ? (
        <p className="flex flex-wrap items-center gap-1.5 border-t border-border-subtle pt-2 text-[11px] text-tertiary">
          {t("DashboardIssuance.config.settingConflictsWith")}
          <Tag>{conflictWith}</Tag>
        </p>
      ) : checked && params.length > 0 ? (
        <div className="grid items-start gap-x-3 gap-y-2 border-t border-border-subtle pt-2.5 sm:grid-cols-2">
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

// A single off-chain compliance capacity. Enabling the checkbox is the declaration
// layer. For capacities that carry a config (configurable), the compliance tab
// (allowConfig) reveals a summary + Configure button that opens the config modal;
// the wizard instead shows a hint that config happens on the compliance tab.
// Technical mode swaps in the Expert-view label where one differs.
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
  return (
    <SettingShell
      icon={CAPACITY_ICONS[capKey]}
      checked={checked}
      disabled={disabled}
      onToggle={onToggle}
      label={showTechnical && expertLabel ? t(expertLabel) : t(meta.labelKey)}
      description={t(meta.descriptionKey)}
    >
      {checked && configurable && allowConfig ? (
        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border-subtle pt-2.5">
          <span className="min-w-0 flex-1 truncate text-xs text-tertiary">
            {summary ?? t("DashboardIssuance.config.capacityConfig.notConfigured")}
          </span>
          <button
            type="button"
            onClick={onConfigure}
            disabled={disabled}
            className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-primary transition-colors hover:underline"
          >
            {t("DashboardIssuance.config.capacityConfig.configure")}
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      ) : checked && configurable ? (
        <p className="mt-2 border-t border-border-subtle pt-2 text-[11px] leading-relaxed text-tertiary">
          {t("DashboardIssuance.config.capacityConfig.setupInComplianceTab")}
        </p>
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
