"use client";

import {
  type ApiKeyRole,
  getPermissionsForApiKeyRole,
  type PolicyDefaultAction,
  type WalletOperationFamily,
} from "@sdp/types";
import {
  AlertTriangle,
  Check,
  CircleCheck,
  FileText,
  KeyRound,
  Layers,
  LockKeyhole,
  Search,
  ShieldCheck,
  Star,
  Wallet,
} from "lucide-react";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import { cn } from "@/lib/utils";
import { saveApiKeyAuthoringAction } from "./actions";
import {
  API_KEY_AUTHORING_STEPS,
  type ApiKeyAuthoringDraft,
  type ApiKeyAuthoringExistingKey,
  type ApiKeyAuthoringMode,
  type ApiKeyAuthoringStep,
  type BindingConfirmation,
  buildApiKeyPolicyRules,
  createApiKeyAuthoringDraft,
  getPolicyBindingIntent,
  isPositiveDecimal,
  requiredBindingConfirmation,
} from "./api-key-authoring";
import type { ApiKeyAuthoringWallet, WalletControlStatus } from "./api-key-authoring.data";

const API_KEYS_PATH = "/dashboard/api-keys";

const ROLE_OPTIONS: ApiKeyRole[] = ["api_admin", "api_developer", "api_readonly"];
const FAMILY_OPTIONS: WalletOperationFamily[] = [
  "transfer",
  "payment",
  "ramp",
  "issuance",
  "raw_sign",
  "program",
  "provider_admin",
];
const DEFAULT_ACTIONS: PolicyDefaultAction[] = ["allow", "deny", "approval_required"];

interface ApiKeyAuthoringWorkspaceProps {
  mode: ApiKeyAuthoringMode;
  wallets: ApiKeyAuthoringWallet[];
  initialKey?: ApiKeyAuthoringExistingKey;
}

function toLocalDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function draftFromInitialKey(initialKey?: ApiKeyAuthoringExistingKey): ApiKeyAuthoringDraft {
  const empty = createApiKeyAuthoringDraft();
  if (!initialKey) return empty;
  const restrictionsEnabled = initialKey.policyBindings.some(
    (binding) => binding.apiKeyControlProfileId
  );
  return {
    ...empty,
    name: initialKey.name,
    role: initialKey.role,
    expiresAt: toLocalDateTime(initialKey.expiresAt),
    walletScope: initialKey.walletScope,
    selectedWalletIds: initialKey.signingWalletIds,
    defaultWalletId: initialKey.signingWalletId ?? initialKey.signingWalletIds[0] ?? "",
    restrictionsEnabled,
    restrictionsEdited: false,
  };
}

function walletLabel(wallet: ApiKeyAuthoringWallet): string {
  return wallet.label?.trim() || wallet.walletId;
}

function shortAddress(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 7)}...${value.slice(-7)}`;
}

function roleLabel(role: ApiKeyRole, t: ReturnType<typeof useTranslations>): string {
  if (role === "api_admin") return t("DashboardCustody.admin");
  if (role === "api_readonly") return t("DashboardCustody.readOnly");
  return t("DashboardCustody.developer");
}

function familyLabel(family: WalletOperationFamily, t: ReturnType<typeof useTranslations>): string {
  const labels: Record<WalletOperationFamily, string> = {
    transfer: t("DashboardCustody.apiKeyFamilyTransfer"),
    payment: t("DashboardCustody.apiKeyFamilyPayment"),
    ramp: t("DashboardCustody.apiKeyFamilyRamp"),
    issuance: t("DashboardCustody.apiKeyFamilyIssuance"),
    raw_sign: t("DashboardCustody.apiKeyFamilyRawSign"),
    program: t("DashboardCustody.apiKeyFamilyProgram"),
    provider_admin: t("DashboardCustody.apiKeyFamilyProviderAdmin"),
  };
  return labels[family];
}

function defaultActionLabel(
  action: PolicyDefaultAction,
  t: ReturnType<typeof useTranslations>
): string {
  if (action === "deny") return t("DashboardCustody.policyDenied");
  if (action === "approval_required" || action === "review") {
    return t("DashboardCustody.policyApprovalRequired");
  }
  return t("DashboardCustody.policyAllowed");
}

function controlStatusLabel(
  status: WalletControlStatus,
  t: ReturnType<typeof useTranslations>
): string {
  if (status === "draft") return t("DashboardCustody.apiKeyPolicyStatusDraft");
  if (status === "active") return t("DashboardCustody.active");
  if (status === "disabled") return t("DashboardCustody.apiKeyPolicyStatusDisabled");
  return t("DashboardCustody.apiKeyPolicyStatusDefaultAllow");
}

function controlStatusVariant(status: WalletControlStatus): "default" | "success" | "warning" {
  if (status === "active") return "success";
  if (status === "draft") return "warning";
  return "default";
}

function WorkSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border-default bg-surface-raised p-5">
      <div>
        <h3 className="text-base font-medium text-primary">{title}</h3>
        {description ? <p className="mt-1 text-sm text-secondary">{description}</p> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function WizardProgress({ currentStep }: { currentStep: ApiKeyAuthoringStep }) {
  const t = useTranslations();
  const currentIndex = API_KEY_AUTHORING_STEPS.indexOf(currentStep);
  const labels = [
    t("DashboardCustody.apiKeyStepDetails"),
    t("DashboardCustody.apiKeyStepPermissions"),
    t("DashboardCustody.apiKeyStepWalletAccess"),
    t("DashboardCustody.apiKeyStepReview"),
  ];

  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          {API_KEY_AUTHORING_STEPS.map((step, index) => (
            <span
              key={step}
              className={cn(
                "h-1.5 rounded-full transition-all",
                index === currentIndex
                  ? "w-4 bg-primary"
                  : index < currentIndex
                    ? "w-1.5 bg-primary"
                    : "w-1.5 bg-fill-strong"
              )}
            />
          ))}
        </div>
        <span className="text-xs text-muted">
          {t("DashboardCustody.stepOf", {
            current: currentIndex + 1,
            total: API_KEY_AUTHORING_STEPS.length,
          })}
        </span>
      </div>
      <ol
        className="mt-5 grid grid-cols-4 border-b border-border-default"
        aria-label={t("DashboardCustody.apiKeyAuthoringProgress")}
      >
        {labels.map((label, index) => (
          <li
            key={label}
            aria-current={index === currentIndex ? "step" : undefined}
            className={cn(
              "min-w-0 border-b-2 px-2 pb-2 text-center text-xs sm:text-sm",
              index === currentIndex
                ? "border-primary font-medium text-primary"
                : "border-transparent text-tertiary"
            )}
          >
            {label}
          </li>
        ))}
      </ol>
    </div>
  );
}

function DetailsStep({
  draft,
  environment,
  update,
}: {
  draft: ApiKeyAuthoringDraft;
  environment: string;
  update: (patch: Partial<ApiKeyAuthoringDraft>) => void;
}) {
  const t = useTranslations();
  return (
    <div>
      <h2 className="text-2xl font-medium text-primary">
        {t("DashboardCustody.apiKeyDetailsTitle")}
      </h2>
      <p className="mt-1.5 text-sm text-secondary">
        {t("DashboardCustody.apiKeyDetailsDescription")}
      </p>
      <div className="mt-5 space-y-4">
        <WorkSection title={t("DashboardCustody.apiKeyIdentity")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="api-key-name">{t("DashboardCustody.nameLabel")}</Label>
              <Input
                id="api-key-name"
                className="mt-2"
                value={draft.name}
                onChange={(event) => update({ name: event.currentTarget.value })}
                placeholder={t("DashboardCustody.namePlaceholder")}
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="api-key-environment">{t("DashboardCustody.environment")}</Label>
              <div
                id="api-key-environment"
                className="mt-2 flex h-10 items-center rounded-lg border border-border-default bg-fill-subtle px-3 text-sm text-primary"
              >
                {environment}
              </div>
            </div>
            <div>
              <Label htmlFor="api-key-expiration">{t("DashboardCustody.expirationOptional")}</Label>
              <Input
                id="api-key-expiration"
                className="mt-2"
                type="datetime-local"
                value={draft.expiresAt}
                onChange={(event) => update({ expiresAt: event.currentTarget.value })}
              />
            </div>
          </div>
        </WorkSection>
      </div>
    </div>
  );
}

function PermissionsStep({
  draft,
  mode,
  update,
}: {
  draft: ApiKeyAuthoringDraft;
  mode: ApiKeyAuthoringMode;
  update: (patch: Partial<ApiKeyAuthoringDraft>) => void;
}) {
  const t = useTranslations();
  const permissions = getPermissionsForApiKeyRole(draft.role);
  return (
    <div>
      <h2 className="text-2xl font-medium text-primary">
        {t("DashboardCustody.apiKeyPermissionsTitle")}
      </h2>
      <p className="mt-1.5 text-sm text-secondary">
        {t("DashboardCustody.apiKeyPermissionsDescription")}
      </p>
      <div className="mt-5 space-y-4">
        <WorkSection
          title={t("DashboardCustody.endpointPermissions")}
          description={mode === "edit" ? t("DashboardCustody.apiKeyRoleFixedOnEdit") : undefined}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {ROLE_OPTIONS.map((role) => {
              const checked = draft.role === role;
              return (
                <label
                  key={role}
                  className={cn(
                    "flex min-h-24 items-start gap-3 rounded-lg border p-4",
                    checked ? "border-primary bg-fill-subtle" : "border-border-default",
                    mode === "edit" ? "cursor-default" : "cursor-pointer"
                  )}
                >
                  <input
                    type="radio"
                    name="api-key-role"
                    value={role}
                    checked={checked}
                    disabled={mode === "edit"}
                    onChange={() => update({ role })}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-primary">
                      {roleLabel(role, t)}
                    </span>
                    <span className="mt-1 block text-xs text-secondary">
                      {t(`DashboardCustody.apiKeyRoleDescription.${role}`)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="mt-4 flex items-start gap-3 rounded-lg bg-fill-subtle p-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-tertiary" />
            <div>
              <p className="text-sm font-medium text-primary">
                {permissions.includes("*")
                  ? t("DashboardCustody.apiKeyFullEndpointAccess")
                  : t("DashboardCustody.apiKeyPermissionCount", { count: permissions.length })}
              </p>
              <p className="mt-1 text-xs text-secondary">
                {t("DashboardCustody.apiKeyPermissionsSeparateFromPolicy")}
              </p>
            </div>
          </div>
        </WorkSection>
      </div>
    </div>
  );
}

function WalletRow({
  wallet,
  checked,
  isDefault,
  onToggle,
  onMakeDefault,
}: {
  wallet: ApiKeyAuthoringWallet;
  checked: boolean;
  isDefault: boolean;
  onToggle: () => void;
  onMakeDefault: () => void;
}) {
  const t = useTranslations();
  const label = walletLabel(wallet);
  return (
    <div className="flex items-center gap-3 border-b border-border-subtle px-3 py-3 last:border-b-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={t("DashboardCustody.apiKeySelectWallet", { wallet: label })}
      />
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-fill-subtle text-secondary">
        <Wallet className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-primary">{label}</p>
        <p className="truncate text-xs text-secondary">{shortAddress(wallet.publicKey)}</p>
      </div>
      {checked ? (
        isDefault ? (
          <Badge className="shrink-0 text-[10px]">
            {t("DashboardCustody.defaultSigningWallet")}
          </Badge>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="size-8 shrink-0"
                  onClick={onMakeDefault}
                  aria-label={t("DashboardCustody.apiKeyMakeDefaultWallet", { wallet: label })}
                >
                  <Star className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t("DashboardCustody.apiKeyMakeDefaultSigningWallet")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )
      ) : null}
    </div>
  );
}

function WalletBaseline({ wallets }: { wallets: ApiKeyAuthoringWallet[] }) {
  const t = useTranslations();
  if (wallets.length === 0) {
    return <p className="text-sm text-secondary">{t("DashboardCustody.apiKeyNoWalletBaseline")}</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border-default">
      {wallets.map((wallet) => (
        <div
          key={wallet.walletId}
          className="flex items-center gap-3 border-b border-border-subtle px-3 py-3 last:border-b-0"
        >
          <ShieldCheck className="size-4 shrink-0 text-tertiary" />
          <span className="min-w-0 flex-1 truncate text-sm text-primary">
            {walletLabel(wallet)}
          </span>
          {wallet.activeRevisionNumber ? (
            <span className="text-xs text-secondary">
              {t("DashboardCustody.apiKeyActiveRevision", {
                revision: wallet.activeRevisionNumber,
              })}
            </span>
          ) : null}
          <Badge
            variant={controlStatusVariant(wallet.controlStatus)}
            className="shrink-0 text-[10px]"
          >
            {controlStatusLabel(wallet.controlStatus, t)}
          </Badge>
        </div>
      ))}
    </div>
  );
}

function RestrictionGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border-default pt-4 first:border-t-0 first:pt-0">
      <h4 className="mb-3 text-sm font-medium text-primary">{title}</h4>
      {children}
    </section>
  );
}

function RestrictionEditor({
  draft,
  preservingExisting,
  update,
}: {
  draft: ApiKeyAuthoringDraft;
  preservingExisting: boolean;
  update: (patch: Partial<ApiKeyAuthoringDraft>) => void;
}) {
  const t = useTranslations();
  const toggleFamily = (family: WalletOperationFamily) => {
    update({
      restrictionsEdited: true,
      operationFamilies: draft.operationFamilies.includes(family)
        ? draft.operationFamilies.filter((item) => item !== family)
        : [...draft.operationFamilies, family],
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-fill-subtle p-3 text-sm text-secondary">
        {t("DashboardCustody.apiKeyRestrictionsNarrowCopy")}
      </div>
      {preservingExisting ? (
        <div className="flex flex-col gap-3 rounded-lg border border-info-border bg-info-bg p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-primary">
              {t("DashboardCustody.apiKeyExistingRestrictionsActive")}
            </p>
            <p className="mt-1 text-xs text-secondary">
              {t("DashboardCustody.apiKeyExistingRestrictionsPreserved")}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => update({ restrictionsEdited: true })}
          >
            {t("DashboardCustody.apiKeyReplaceRestrictionDetails")}
          </Button>
        </div>
      ) : null}
      <fieldset
        disabled={preservingExisting}
        className={cn("space-y-4", preservingExisting && "opacity-55")}
      >
        <RestrictionGroup title={t("DashboardCustody.apiKeyAdditionalDefaultAction")}>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-fill-subtle p-1 sm:grid-cols-4">
            {DEFAULT_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => update({ defaultAction: action, restrictionsEdited: true })}
                className={cn(
                  "min-h-9 rounded-md px-2 text-xs font-medium",
                  draft.defaultAction === action
                    ? "border border-border-default bg-surface-raised text-primary shadow-sm"
                    : "text-secondary"
                )}
              >
                {defaultActionLabel(action, t)}
              </button>
            ))}
          </div>
        </RestrictionGroup>
        <RestrictionGroup title={t("DashboardCustody.apiKeyAdditionalOperationFamilies")}>
          <div className="grid gap-2 sm:grid-cols-2">
            {FAMILY_OPTIONS.map((family) => (
              <label key={family} className="flex items-center gap-2 text-sm text-primary">
                <input
                  type="checkbox"
                  checked={draft.operationFamilies.includes(family)}
                  onChange={() => toggleFamily(family)}
                />
                {familyLabel(family, t)}
              </label>
            ))}
          </div>
        </RestrictionGroup>
        <RestrictionGroup title={t("DashboardCustody.apiKeyAdditionalOperationTypes")}>
          <Label htmlFor="api-key-operation-types" className="sr-only">
            {t("DashboardCustody.apiKeyAdditionalOperationTypes")}
          </Label>
          <Input
            id="api-key-operation-types"
            value={draft.operationTypes}
            onChange={(event) =>
              update({ operationTypes: event.currentTarget.value, restrictionsEdited: true })
            }
            placeholder={t("DashboardCustody.apiKeyOperationTypesPlaceholder")}
          />
        </RestrictionGroup>
        <RestrictionGroup title={t("DashboardCustody.apiKeyAdditionalAssets")}>
          <Label htmlFor="api-key-assets" className="sr-only">
            {t("DashboardCustody.apiKeyAdditionalAssets")}
          </Label>
          <Input
            id="api-key-assets"
            value={draft.assets}
            onChange={(event) =>
              update({ assets: event.currentTarget.value, restrictionsEdited: true })
            }
            placeholder={t("DashboardCustody.apiKeyAssetsPlaceholder")}
          />
        </RestrictionGroup>
        <RestrictionGroup title={t("DashboardCustody.apiKeyAdditionalAmounts")}>
          <Label htmlFor="api-key-maximum-amount">
            {t("DashboardCustody.apiKeyMaximumAmount")}
          </Label>
          <Input
            id="api-key-maximum-amount"
            className="mt-2"
            inputMode="decimal"
            value={draft.maximumAmount}
            onChange={(event) =>
              update({ maximumAmount: event.currentTarget.value, restrictionsEdited: true })
            }
            placeholder={t("DashboardCustody.apiKeyMaximumAmountPlaceholder")}
          />
          {draft.maximumAmount && !isPositiveDecimal(draft.maximumAmount) ? (
            <p className="mt-2 text-xs text-destructive">
              {t("DashboardCustody.apiKeyRestrictionAmountInvalid")}
            </p>
          ) : null}
        </RestrictionGroup>
        <RestrictionGroup title={t("DashboardCustody.apiKeyAdditionalDestinations")}>
          <Label htmlFor="api-key-destinations" className="sr-only">
            {t("DashboardCustody.apiKeyAdditionalDestinations")}
          </Label>
          <textarea
            id="api-key-destinations"
            className="min-h-24 w-full rounded-lg border border-border-default bg-surface-raised px-3 py-2 text-sm text-primary outline-none focus:border-primary"
            value={draft.destinations}
            onChange={(event) =>
              update({ destinations: event.currentTarget.value, restrictionsEdited: true })
            }
            placeholder={t("DashboardCustody.apiKeyDestinationsPlaceholder")}
          />
        </RestrictionGroup>
        <RestrictionGroup title={t("DashboardCustody.apiKeyAdditionalApprovals")}>
          <label className="flex items-start gap-3 text-sm text-primary">
            <input
              type="checkbox"
              checked={draft.approvalRequired}
              onChange={(event) =>
                update({ approvalRequired: event.currentTarget.checked, restrictionsEdited: true })
              }
              className="mt-1"
            />
            <span>
              <span className="block font-medium">
                {t("DashboardCustody.apiKeyRequireApproval")}
              </span>
              <span className="mt-1 block text-xs text-secondary">
                {t("DashboardCustody.apiKeyRequireApprovalDescription")}
              </span>
            </span>
          </label>
        </RestrictionGroup>
      </fieldset>
    </div>
  );
}

function WalletPolicyStep({
  draft,
  wallets,
  hadExistingRestrictions,
  update,
}: {
  draft: ApiKeyAuthoringDraft;
  wallets: ApiKeyAuthoringWallet[];
  hadExistingRestrictions: boolean;
  update: (patch: Partial<ApiKeyAuthoringDraft>) => void;
}) {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const selectedWallets = wallets.filter((wallet) =>
    draft.selectedWalletIds.includes(wallet.walletId)
  );
  const baselineWallets = draft.walletScope === "all" ? wallets : selectedWallets;
  const filteredWallets = wallets.filter((wallet) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return `${walletLabel(wallet)} ${wallet.walletId} ${wallet.publicKey}`
      .toLowerCase()
      .includes(query);
  });
  const toggleWallet = (walletId: string) => {
    const selectedWalletIds = draft.selectedWalletIds.includes(walletId)
      ? draft.selectedWalletIds.filter((item) => item !== walletId)
      : [...draft.selectedWalletIds, walletId];
    update({
      selectedWalletIds,
      defaultWalletId: selectedWalletIds.includes(draft.defaultWalletId)
        ? draft.defaultWalletId
        : (selectedWalletIds[0] ?? ""),
    });
  };
  const preservingExisting = hadExistingRestrictions && !draft.restrictionsEdited;

  return (
    <div>
      <h2 className="text-2xl font-medium text-primary">
        {t("DashboardCustody.apiKeyWalletPolicyTitle")}
      </h2>
      <p className="mt-1.5 text-sm text-secondary">
        {t("DashboardCustody.apiKeyWalletPolicyDescription")}
      </p>
      <div className="mt-5 space-y-4">
        <WorkSection title={t("DashboardCustody.walletAccess")}>
          <div className="space-y-3">
            <label className="flex items-start gap-3 rounded-lg border border-border-default p-3">
              <input
                type="radio"
                name="wallet-scope"
                checked={draft.walletScope === "all"}
                onChange={() => update({ walletScope: "all" })}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-primary">
                  {t("DashboardCustody.allWallets")}
                </span>
                <span className="mt-1 block text-xs text-secondary">
                  {t("DashboardCustody.apiKeyAllWalletsHelper")}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-lg border border-border-default p-3">
              <input
                type="radio"
                name="wallet-scope"
                checked={draft.walletScope === "selected"}
                onChange={() => update({ walletScope: "selected" })}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-primary">
                  {t("DashboardCustody.selectedWallets")}
                </span>
                <span className="mt-1 block text-xs text-secondary">
                  {t("DashboardCustody.selectedWalletsDescription")}
                </span>
              </span>
            </label>
          </div>
          {draft.walletScope === "selected" ? (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="api-key-wallet-search">
                  {t("DashboardCustody.apiKeySelectedWalletCount", {
                    count: selectedWallets.length,
                  })}
                </Label>
              </div>
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                <Input
                  id="api-key-wallet-search"
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  placeholder={t("DashboardCustody.apiKeySearchWallets")}
                  className="pl-9"
                />
              </div>
              <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-border-default">
                {filteredWallets.length > 0 ? (
                  filteredWallets.map((wallet) => (
                    <WalletRow
                      key={wallet.walletId}
                      wallet={wallet}
                      checked={draft.selectedWalletIds.includes(wallet.walletId)}
                      isDefault={draft.defaultWalletId === wallet.walletId}
                      onToggle={() => toggleWallet(wallet.walletId)}
                      onMakeDefault={() => update({ defaultWalletId: wallet.walletId })}
                    />
                  ))
                ) : (
                  <p className="p-4 text-sm text-secondary">
                    {t("DashboardCustody.apiKeyNoWalletSearchResults")}
                  </p>
                )}
              </div>
              {selectedWallets.length === 0 ? (
                <p className="mt-2 text-xs text-destructive">
                  {t("DashboardCustody.apiKeyWalletRequired")}
                </p>
              ) : null}
            </div>
          ) : null}
        </WorkSection>

        <WorkSection
          title={t("DashboardCustody.apiKeyWalletControlsEnforced")}
          description={t("DashboardCustody.apiKeyWalletControlsDescription")}
        >
          <WalletBaseline wallets={baselineWallets} />
        </WorkSection>

        <WorkSection title={t("DashboardCustody.apiKeyRestrictionsTitle")}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-primary">
                {t("DashboardCustody.apiKeyAddRestrictions")}
              </p>
              {!draft.restrictionsEnabled ? (
                <p className="mt-1 text-xs text-secondary">
                  {t("DashboardCustody.apiKeyNoAdditionalRestrictions")}
                </p>
              ) : null}
            </div>
            <ToggleSwitch
              checked={draft.restrictionsEnabled}
              aria-label={t("DashboardCustody.apiKeyAddRestrictions")}
              onChange={(restrictionsEnabled) =>
                update({
                  restrictionsEnabled,
                  restrictionsEdited: restrictionsEnabled ? !hadExistingRestrictions : false,
                })
              }
            />
          </div>
          {draft.restrictionsEnabled ? (
            <div className="mt-4">
              <RestrictionEditor
                draft={draft}
                preservingExisting={preservingExisting}
                update={update}
              />
            </div>
          ) : null}
        </WorkSection>
      </div>
    </div>
  );
}

function ReviewLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border-subtle py-2.5 last:border-b-0">
      <span className="text-sm text-secondary">{label}</span>
      <span className="max-w-[65%] text-right text-sm font-medium text-primary">{value}</span>
    </div>
  );
}

function ReviewStep({
  draft,
  wallets,
  bindingSummary,
}: {
  draft: ApiKeyAuthoringDraft;
  wallets: ApiKeyAuthoringWallet[];
  bindingSummary: string;
}) {
  const t = useTranslations();
  const selectedWallets = wallets.filter((wallet) =>
    draft.selectedWalletIds.includes(wallet.walletId)
  );
  const baselineWallets = draft.walletScope === "all" ? wallets : selectedWallets;
  const defaultAllowWallets = baselineWallets.filter(
    (wallet) => wallet.controlStatus === "default_allow"
  );
  const rules = buildApiKeyPolicyRules(draft);

  return (
    <div>
      <h2 className="text-2xl font-medium text-primary">
        {t("DashboardCustody.apiKeyReviewTitle")}
      </h2>
      <p className="mt-1.5 text-sm text-secondary">
        {t("DashboardCustody.apiKeyReviewDescription")}
      </p>
      <div className="mt-5 space-y-4">
        <WorkSection title={t("DashboardCustody.apiKeyReviewIdentity")}>
          <ReviewLine label={t("DashboardCustody.name")} value={draft.name} />
          <ReviewLine
            label={t("DashboardCustody.expirationOptional")}
            value={draft.expiresAt || t("DashboardCustody.none")}
          />
        </WorkSection>
        <WorkSection title={t("DashboardCustody.apiKeyReviewPermissions")}>
          <ReviewLine label={t("DashboardCustody.role")} value={roleLabel(draft.role, t)} />
          <ReviewLine
            label={t("DashboardCustody.endpointPermissions")}
            value={
              getPermissionsForApiKeyRole(draft.role).includes("*")
                ? t("DashboardCustody.apiKeyFullEndpointAccess")
                : t("DashboardCustody.apiKeyPermissionCount", {
                    count: getPermissionsForApiKeyRole(draft.role).length,
                  })
            }
          />
        </WorkSection>
        <WorkSection title={t("DashboardCustody.apiKeyReviewWalletAccess")}>
          <ReviewLine
            label={t("DashboardCustody.walletAccess")}
            value={
              draft.walletScope === "all"
                ? t("DashboardCustody.allWallets")
                : t("DashboardCustody.selected", { count: selectedWallets.length })
            }
          />
          {draft.walletScope === "selected" ? (
            <ReviewLine
              label={t("DashboardCustody.selectedWallets")}
              value={selectedWallets.map(walletLabel).join(", ")}
            />
          ) : null}
        </WorkSection>
        <WorkSection title={t("DashboardCustody.apiKeyReviewWalletBaseline")}>
          <WalletBaseline wallets={baselineWallets} />
        </WorkSection>
        <WorkSection title={t("DashboardCustody.apiKeyReviewRestrictions")}>
          <ReviewLine
            label={t("DashboardCustody.apiKeyRestrictionsTitle")}
            value={
              draft.restrictionsEnabled
                ? draft.restrictionsEdited
                  ? t("DashboardCustody.apiKeyRestrictionRuleCount", { count: rules.length })
                  : t("DashboardCustody.apiKeyExistingRestrictionsPreservedShort")
                : t("DashboardCustody.apiKeyNoAdditionalRestrictions")
            }
          />
          {draft.restrictionsEnabled ? (
            <ReviewLine
              label={t("DashboardCustody.apiKeyAdditionalDefaultAction")}
              value={defaultActionLabel(draft.defaultAction, t)}
            />
          ) : null}
        </WorkSection>
        <WorkSection title={t("DashboardCustody.apiKeyReviewBindingChanges")}>
          <p className="text-sm text-secondary">{bindingSummary}</p>
        </WorkSection>
        {defaultAllowWallets.length > 0 ? (
          <div className="flex items-start gap-3 rounded-lg border border-warning-border bg-warning-bg p-4">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="text-sm text-primary">
              {t("DashboardCustody.apiKeyDefaultAllowWarning", {
                wallets: defaultAllowWallets.map(walletLabel).join(", "),
              })}
            </p>
          </div>
        ) : null}
        {draft.restrictionsEnabled &&
        draft.walletScope === "selected" &&
        selectedWallets.length === 0 ? (
          <div className="flex items-start gap-3 rounded-lg border border-destructive-border bg-destructive-bg p-4">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-sm text-primary">
              {t("DashboardCustody.apiKeyRestrictionNoReachableWalletWarning")}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SummaryRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5 border-b border-border-subtle py-2.5 last:border-b-0">
      <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
      <span className="text-sm text-tertiary">{label}</span>
      <span className="ml-auto min-w-0 max-w-[58%] break-words text-right text-sm font-medium text-primary">
        {value}
      </span>
    </div>
  );
}

function KeySummary({
  draft,
  wallets,
  environment,
  bindingSummary,
}: {
  draft: ApiKeyAuthoringDraft;
  wallets: ApiKeyAuthoringWallet[];
  environment: string;
  bindingSummary: string;
}) {
  const t = useTranslations();
  const selectedWallets = wallets.filter((wallet) =>
    draft.selectedWalletIds.includes(wallet.walletId)
  );
  const baselineWallets = draft.walletScope === "all" ? wallets : selectedWallets;
  const restrictions = draft.restrictionsEnabled
    ? draft.restrictionsEdited
      ? t("DashboardCustody.apiKeyRestrictionRuleCount", {
          count: buildApiKeyPolicyRules(draft).length,
        })
      : t("DashboardCustody.apiKeyExistingRestrictionsPreservedShort")
    : t("DashboardCustody.apiKeyNoAdditionalRestrictions");
  const baseline = baselineWallets.length
    ? baselineWallets
        .map((wallet) => `${walletLabel(wallet)}: ${controlStatusLabel(wallet.controlStatus, t)}`)
        .join(", ")
    : t("DashboardCustody.none");

  return (
    <aside className="lg:sticky lg:top-4">
      <div className="rounded-lg border border-border-default bg-surface-raised p-5">
        <h2 className="text-base font-medium text-primary">
          {t("DashboardCustody.apiKeySummaryTitle")}
        </h2>
        <div className="mt-3">
          <SummaryRow
            icon={<FileText className="size-4" />}
            label={t("DashboardCustody.name")}
            value={draft.name || t("DashboardCustody.none")}
          />
          <SummaryRow
            icon={<Layers className="size-4" />}
            label={t("DashboardCustody.environment")}
            value={environment}
          />
          <SummaryRow
            icon={<KeyRound className="size-4" />}
            label={t("DashboardCustody.apiKeySummaryPermissions")}
            value={roleLabel(draft.role, t)}
          />
          <SummaryRow
            icon={<Wallet className="size-4" />}
            label={t("DashboardCustody.walletAccess")}
            value={
              draft.walletScope === "all"
                ? t("DashboardCustody.allWallets")
                : t("DashboardCustody.selectedWallets")
            }
          />
          <SummaryRow
            icon={<CircleCheck className="size-4" />}
            label={t("DashboardCustody.apiKeySummarySelectedWallets")}
            value={
              draft.walletScope === "all"
                ? t("DashboardCustody.apiKeyAllReachableWallets")
                : t("DashboardCustody.selected", { count: selectedWallets.length })
            }
          />
          <SummaryRow
            icon={<ShieldCheck className="size-4" />}
            label={t("DashboardCustody.apiKeySummaryWalletBaseline")}
            value={baseline}
          />
          <SummaryRow
            icon={<LockKeyhole className="size-4" />}
            label={t("DashboardCustody.apiKeySummaryRestrictions")}
            value={restrictions}
          />
          <SummaryRow
            icon={<Check className="size-4" />}
            label={t("DashboardCustody.apiKeySummaryBindingScope")}
            value={bindingSummary}
          />
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-fill-subtle p-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-tertiary" />
          <p className="text-xs text-secondary">
            {t("DashboardCustody.apiKeyWalletControlsAlwaysApply")}
          </p>
        </div>
      </div>
    </aside>
  );
}

function BindingChangeDialog({
  open,
  confirmation,
  walletNames,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  confirmation: BindingConfirmation;
  walletNames: string[];
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  const clear = confirmation === "clear";
  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      closeDisabled={submitting}
      ariaLabel={
        clear
          ? t("DashboardCustody.apiKeyClearBindings")
          : t("DashboardCustody.apiKeyReplaceBindings")
      }
      size="sm"
    >
      <div className="space-y-5 p-6">
        <div>
          <h2 className="text-xl font-medium text-primary">
            {clear
              ? t("DashboardCustody.apiKeyClearBindingsTitle")
              : t("DashboardCustody.apiKeyReplaceBindingsTitle")}
          </h2>
          <p className="mt-2 text-sm text-secondary">
            {clear
              ? t("DashboardCustody.apiKeyClearBindingsDescription")
              : t("DashboardCustody.apiKeyReplaceBindingsDescription")}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-tertiary">
            {t("DashboardCustody.apiKeyAffectedWallets")}
          </p>
          <ul className="mt-2 divide-y divide-border-subtle rounded-lg border border-border-default px-3">
            {walletNames.map((name) => (
              <li key={name} className="py-2 text-sm text-primary">
                {name}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            {t("DashboardCustody.cancel")}
          </Button>
          <Button type="button" onClick={onConfirm} disabled={submitting}>
            {clear
              ? t("DashboardCustody.apiKeyClearBindings")
              : t("DashboardCustody.apiKeyReplaceBindings")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function bindingSummaryLabel(
  intent: ReturnType<typeof getPolicyBindingIntent>,
  mode: ApiKeyAuthoringMode,
  t: ReturnType<typeof useTranslations>
): string {
  if (intent.mode === "none") {
    return mode === "create"
      ? t("DashboardCustody.apiKeyNoPolicyBindings")
      : t("DashboardCustody.apiKeyBindingsUnchanged");
  }
  if (intent.mode === "clear") return t("DashboardCustody.apiKeyBindingsWillClear");
  if (intent.mode === "blocked") {
    return t("DashboardCustody.apiKeyRestrictionReplacementRequired");
  }
  if (mode === "create") return t("DashboardCustody.apiKeyBindingsWillCreate");
  return t("DashboardCustody.apiKeyBindingsWillReplace");
}

export function ApiKeyAuthoringWorkspace({
  mode,
  wallets,
  initialKey,
}: ApiKeyAuthoringWorkspaceProps) {
  const t = useTranslations();
  const router = useDashboardRouter();
  const { sdpEnvironment } = useDashboardWorkspace();
  const [currentStep, setCurrentStep] = useState<ApiKeyAuthoringStep>("details");
  const [draft, setDraft] = useState(() => draftFromInitialKey(initialKey));
  const [dialogConfirmation, setDialogConfirmation] = useState<BindingConfirmation | null>(null);
  const [isPending, startTransition] = useTransition();
  const initialState = initialKey
    ? {
        walletScope: initialKey.walletScope,
        selectedWalletIds: initialKey.signingWalletIds,
        policyBindings: initialKey.policyBindings,
      }
    : null;
  const bindingIntent = getPolicyBindingIntent(mode, initialState, draft);
  const bindingConfirmation = requiredBindingConfirmation(bindingIntent);
  const hadExistingRestrictions = Boolean(
    initialKey?.policyBindings.some((binding) => binding.apiKeyControlProfileId)
  );
  const environment =
    (initialKey?.environment ?? sdpEnvironment) === "production"
      ? t("DashboardCustody.production")
      : t("DashboardCustody.sandbox");
  const currentStepIndex = API_KEY_AUTHORING_STEPS.indexOf(currentStep);
  const selectedWalletCount = draft.selectedWalletIds.length;
  const amountValid = !draft.maximumAmount || isPositiveDecimal(draft.maximumAmount);
  const canContinue =
    currentStep === "details"
      ? draft.name.trim().length > 0
      : currentStep === "wallets"
        ? (draft.walletScope === "all" || selectedWalletCount > 0) &&
          amountValid &&
          bindingIntent.mode !== "blocked"
        : true;
  const bindingSummary = bindingSummaryLabel(bindingIntent, mode, t);
  let affectedWalletNames: string[] = [];
  if (bindingIntent.mode === "replace" || bindingIntent.mode === "clear") {
    const byId = new Map(wallets.map((wallet) => [wallet.walletId, walletLabel(wallet)]));
    affectedWalletNames = bindingIntent.affectedTargets.includes("all")
      ? wallets.map(walletLabel)
      : bindingIntent.affectedTargets.map((target) => byId.get(target) ?? target);
  }

  const update = (patch: Partial<ApiKeyAuthoringDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const submit = (confirmation?: BindingConfirmation) => {
    startTransition(async () => {
      const result = await saveApiKeyAuthoringAction({
        mode,
        keyId: initialKey?.id,
        draft,
        bindingConfirmation: confirmation,
      });
      if (!result.ok) {
        toast.error(result.message, { position: "bottom-right" });
        return;
      }
      toast.success(result.message, { position: "bottom-right" });
      router.push(API_KEYS_PATH);
      router.refresh();
    });
  };

  const handlePrimary = () => {
    if (!canContinue || isPending) return;
    if (currentStep !== "review") {
      setCurrentStep(API_KEY_AUTHORING_STEPS[currentStepIndex + 1]);
      return;
    }
    if (bindingConfirmation) {
      setDialogConfirmation(bindingConfirmation);
      return;
    }
    submit();
  };

  const handleBack = () => {
    if (currentStepIndex === 0) {
      router.push(API_KEYS_PATH);
      return;
    }
    setCurrentStep(API_KEY_AUTHORING_STEPS[currentStepIndex - 1]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-2 pb-5 md:px-6">
        <div className="mx-auto w-full max-w-6xl">
          <WizardProgress currentStep={currentStep} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        <div className="mx-auto grid w-full max-w-6xl gap-8 pb-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            {currentStep === "details" ? (
              <DetailsStep draft={draft} environment={environment} update={update} />
            ) : null}
            {currentStep === "permissions" ? (
              <PermissionsStep draft={draft} mode={mode} update={update} />
            ) : null}
            {currentStep === "wallets" ? (
              <WalletPolicyStep
                draft={draft}
                wallets={wallets}
                hadExistingRestrictions={hadExistingRestrictions}
                update={update}
              />
            ) : null}
            {currentStep === "review" ? (
              <ReviewStep draft={draft} wallets={wallets} bindingSummary={bindingSummary} />
            ) : null}
          </div>
          <KeySummary
            draft={draft}
            wallets={wallets}
            environment={environment}
            bindingSummary={bindingSummary}
          />
        </div>
      </div>
      <div className="shrink-0 border-t border-border-default bg-surface-raised/90 px-4 py-4 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
          <Button type="button" variant="secondary" onClick={handleBack} disabled={isPending}>
            {currentStepIndex === 0 ? t("DashboardCustody.cancel") : t("DashboardCustody.back")}
          </Button>
          <Button type="button" onClick={handlePrimary} disabled={!canContinue || isPending}>
            {currentStep === "review"
              ? isPending
                ? t("DashboardCustody.saving")
                : mode === "create"
                  ? t("DashboardCustody.createKey")
                  : t("DashboardCustody.apiKeySaveChanges")
              : t("DashboardCustody.continue")}
          </Button>
        </div>
      </div>
      {dialogConfirmation ? (
        <BindingChangeDialog
          open
          confirmation={dialogConfirmation}
          walletNames={affectedWalletNames}
          submitting={isPending}
          onCancel={() => setDialogConfirmation(null)}
          onConfirm={() => {
            const confirmation = dialogConfirmation;
            setDialogConfirmation(null);
            submit(confirmation);
          }}
        />
      ) : null}
    </div>
  );
}
