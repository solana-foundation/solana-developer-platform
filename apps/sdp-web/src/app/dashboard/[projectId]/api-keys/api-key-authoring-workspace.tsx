"use client";

import {
  type ApiKeyRole,
  getPermissionsForApiKeyRole,
  operationTypesInFamily,
  type PaymentsDashboardWallet,
} from "@sdp/types";
import {
  CircleCheck,
  FileText,
  KeyRound,
  Layers,
  ListChecks,
  Search,
  ShieldCheck,
  Star,
  Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { completeQuickStartStep, quickStartKey } from "@/lib/dashboard-quick-start";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { cn } from "@/lib/utils";
import { saveApiKeyAuthoringAction } from "./actions";
import {
  API_KEY_AUTHORING_STEPS,
  type ApiKeyAuthoringDraft,
  type ApiKeyAuthoringExistingKey,
  type ApiKeyAuthoringMode,
  type ApiKeyAuthoringStep,
  buildAllowedOperations,
  createApiKeyAuthoringDraft,
  familyState,
  isOperationTypeTicked,
  toggleFamily,
  toggleOperationType,
} from "./api-key-authoring";
import {
  API_KEY_OPERATION_FAMILIES,
  familyDescription,
  familyLabel,
  operationsSummaryLabel,
} from "./api-key-operations-labels";

const API_KEYS_PATH = "/dashboard/api-keys";

const ROLE_OPTIONS: ApiKeyRole[] = ["api_admin", "api_developer", "api_readonly"];

interface ApiKeyAuthoringWorkspaceProps {
  mode: ApiKeyAuthoringMode;
  wallets: PaymentsDashboardWallet[];
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
  const allowedOperations = initialKey.allowedOperations ?? [];
  return {
    ...empty,
    name: initialKey.name,
    role: initialKey.role,
    expiresAt: toLocalDateTime(initialKey.expiresAt),
    walletScope: initialKey.walletScope,
    selectedWalletIds: initialKey.signingWalletIds,
    defaultWalletId: initialKey.signingWalletId ?? initialKey.signingWalletIds[0] ?? "",
    operationsScope: allowedOperations.length > 0 ? "selected" : "all",
    selectedOperations: allowedOperations,
  };
}

function walletLabel(wallet: PaymentsDashboardWallet): string {
  return wallet.label?.trim() || wallet.walletId;
}

/** The wallets the key's scope reaches: every wallet, or the selected ones. */
function shortAddress(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 7)}...${value.slice(-7)}`;
}

function roleLabel(role: ApiKeyRole, t: ReturnType<typeof useTranslations>): string {
  if (role === "api_admin") return t("DashboardCustody.admin");
  if (role === "api_readonly") return t("DashboardCustody.readOnly");
  return t("DashboardCustody.developer");
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

function permissionCountLabel(
  permissions: readonly string[],
  t: ReturnType<typeof useTranslations>
): string {
  return permissions.includes("*")
    ? t("DashboardCustody.apiKeyFullEndpointAccess")
    : t("DashboardCustody.apiKeyPermissionCount", { count: permissions.length });
}

/**
 * The endpoint permissions a role grants, spelled out. A bare count left a
 * partner guessing whether "Developer" covered Earn, which is the exact thing
 * the Embedded Yield guide sends them here to check. Callers skip it for the
 * `*` admin sentinel, where "Full endpoint access" is the whole list.
 */
function PermissionChipList({
  className,
  permissions,
}: {
  className?: string;
  permissions: readonly string[];
}) {
  const t = useTranslations();
  return (
    <ul
      aria-label={t("DashboardCustody.endpointPermissions")}
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      {permissions.map((permission) => (
        <li
          key={permission}
          className="rounded-md border border-border-default bg-surface-raised px-2 py-0.5 text-xs font-medium text-secondary"
        >
          {permission}
        </li>
      ))}
    </ul>
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
        <span className="sr-only">: {labels[currentIndex]}</span>
      </span>
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
              <DateTimePicker
                id="api-key-expiration"
                className="mt-2"
                value={draft.expiresAt}
                onChange={(value) => update({ expiresAt: value })}
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
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">
                {permissionCountLabel(permissions, t)}
              </p>
              {permissions.includes("*") ? null : (
                <PermissionChipList className="mt-2" permissions={permissions} />
              )}
              <p className="mt-2 text-xs text-secondary">
                {t("DashboardCustody.apiKeyPermissionsSeparateFromOperations")}
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
  wallet: PaymentsDashboardWallet;
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

function OperationsPicker({
  draft,
  touched,
  update,
}: {
  draft: ApiKeyAuthoringDraft;
  touched: boolean;
  update: (patch: Partial<ApiKeyAuthoringDraft>) => void;
}) {
  const t = useTranslations();
  return (
    <div>
      <div className="space-y-3">
        <label className="flex items-start gap-3 rounded-lg border border-border-default p-3">
          <input
            type="radio"
            name="operations-scope"
            checked={draft.operationsScope === "all"}
            onChange={() => update({ operationsScope: "all" })}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-primary">
              {t("DashboardCustody.apiKeyOperationsAll")}
            </span>
            <span className="mt-1 block text-xs text-secondary">
              {t("DashboardCustody.apiKeyOperationsAllHelper")}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-lg border border-border-default p-3">
          <input
            type="radio"
            name="operations-scope"
            checked={draft.operationsScope === "selected"}
            onChange={() => update({ operationsScope: "selected" })}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-primary">
              {t("DashboardCustody.apiKeyOperationsSelected")}
            </span>
            <span className="mt-1 block text-xs text-secondary">
              {t("DashboardCustody.apiKeyOperationsSelectedHelper")}
            </span>
          </span>
        </label>
      </div>
      {draft.operationsScope === "selected" ? (
        <div className="mt-4 space-y-3">
          {API_KEY_OPERATION_FAMILIES.map((family) => {
            const state = familyState(draft.selectedOperations, family);
            return (
              <div key={family} className="rounded-lg border border-border-default">
                <label className="flex items-start gap-3 p-3">
                  <input
                    type="checkbox"
                    checked={state === "all"}
                    ref={(element) => {
                      // Only part of the family is ticked: show a dash instead of a tick.
                      if (element) element.indeterminate = state === "some";
                    }}
                    onChange={() =>
                      update({ selectedOperations: toggleFamily(draft.selectedOperations, family) })
                    }
                    aria-label={familyLabel(family, t)}
                    aria-describedby={`api-key-family-${family}-description`}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium text-primary">
                      {familyLabel(family, t)}
                    </span>
                    <span
                      id={`api-key-family-${family}-description`}
                      className="mt-1 block text-xs text-secondary"
                    >
                      {familyDescription(family, t)}
                    </span>
                  </span>
                </label>
                {state !== "none" ? (
                  <div className="grid gap-2 border-t border-border-subtle px-3 py-3 sm:grid-cols-2">
                    {operationTypesInFamily(family).map((type) => (
                      <label
                        key={type}
                        className="flex items-center gap-2 font-mono text-xs text-primary"
                      >
                        <input
                          type="checkbox"
                          checked={isOperationTypeTicked(draft.selectedOperations, type)}
                          onChange={() =>
                            update({
                              selectedOperations: toggleOperationType(
                                draft.selectedOperations,
                                type
                              ),
                            })
                          }
                        />
                        {type}
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {touched && draft.selectedOperations.length === 0 ? (
            <p className="text-xs text-destructive">
              {t("DashboardCustody.apiKeyOperationsRequired")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AccessStep({
  draft,
  wallets,
  walletSelectionTouched,
  onWalletSelectionTouched,
  operationsTouched,
  update,
}: {
  draft: ApiKeyAuthoringDraft;
  wallets: PaymentsDashboardWallet[];
  walletSelectionTouched: boolean;
  onWalletSelectionTouched: () => void;
  operationsTouched: boolean;
  update: (patch: Partial<ApiKeyAuthoringDraft>) => void;
}) {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const selectedWallets = wallets.filter((wallet) =>
    draft.selectedWalletIds.includes(wallet.walletId)
  );
  const filteredWallets = wallets.filter((wallet) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return `${walletLabel(wallet)} ${wallet.walletId} ${wallet.publicKey}`
      .toLowerCase()
      .includes(query);
  });
  const toggleWallet = (walletId: string) => {
    onWalletSelectionTouched();
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

  return (
    <div>
      <h2 className="text-2xl font-medium text-primary">
        {t("DashboardCustody.apiKeyAccessTitle")}
      </h2>
      <p className="mt-1.5 text-sm text-secondary">
        {t("DashboardCustody.apiKeyAccessDescription")}
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
                onChange={() => {
                  onWalletSelectionTouched();
                  update({ walletScope: "selected" });
                }}
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
              {walletSelectionTouched && selectedWallets.length === 0 ? (
                <p className="mt-2 text-xs text-destructive">
                  {t("DashboardCustody.apiKeyWalletRequired")}
                </p>
              ) : null}
            </div>
          ) : null}
        </WorkSection>

        <WorkSection
          title={t("DashboardCustody.apiKeyOperationsTitle")}
          description={t("DashboardCustody.apiKeyOperationsDescription")}
        >
          <OperationsPicker draft={draft} touched={operationsTouched} update={update} />
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
}: {
  draft: ApiKeyAuthoringDraft;
  wallets: PaymentsDashboardWallet[];
}) {
  const t = useTranslations();
  const selectedWallets = wallets.filter((wallet) =>
    draft.selectedWalletIds.includes(wallet.walletId)
  );

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
            value={permissionCountLabel(getPermissionsForApiKeyRole(draft.role), t)}
          />
          {getPermissionsForApiKeyRole(draft.role).includes("*") ? null : (
            <PermissionChipList
              className="pt-2.5"
              permissions={getPermissionsForApiKeyRole(draft.role)}
            />
          )}
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
        <WorkSection title={t("DashboardCustody.apiKeyReviewOperations")}>
          <ReviewLine
            label={t("DashboardCustody.apiKeyOperationsTitle")}
            value={operationsSummaryLabel(buildAllowedOperations(draft), t)}
          />
        </WorkSection>
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
}: {
  draft: ApiKeyAuthoringDraft;
  wallets: PaymentsDashboardWallet[];
  environment: string;
}) {
  const t = useTranslations();
  const selectedWallets = wallets.filter((wallet) =>
    draft.selectedWalletIds.includes(wallet.walletId)
  );

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
            icon={<ListChecks className="size-4" />}
            label={t("DashboardCustody.apiKeyOperationsTitle")}
            value={operationsSummaryLabel(buildAllowedOperations(draft), t)}
          />
        </div>
      </div>
    </aside>
  );
}

export function ApiKeyAuthoringWorkspace({
  mode,
  wallets,
  initialKey,
}: ApiKeyAuthoringWorkspaceProps) {
  const t = useTranslations();
  const router = useRouter();
  const href = useProjectHref();
  const { sdpEnvironment, dashboardCacheScope, selectedProjectId } = useDashboardWorkspace();
  const [currentStep, setCurrentStep] = useState<ApiKeyAuthoringStep>("details");
  const [draft, setDraft] = useState(() => draftFromInitialKey(initialKey));
  const [walletSelectionTouched, setWalletSelectionTouched] = useState(false);
  const [operationsTouched, setOperationsTouched] = useState(false);
  const [isPending, startTransition] = useTransition();
  const environment =
    (initialKey?.environment ?? sdpEnvironment) === "production"
      ? t("DashboardCustody.production")
      : t("DashboardCustody.sandbox");
  const currentStepIndex = API_KEY_AUTHORING_STEPS.indexOf(currentStep);
  const selectedWalletCount = draft.selectedWalletIds.length;
  const operationsValid = draft.operationsScope === "all" || draft.selectedOperations.length > 0;
  const canContinue =
    currentStep === "details"
      ? draft.name.trim().length > 0
      : currentStep === "wallets"
        ? (draft.walletScope === "all" || selectedWalletCount > 0) && operationsValid
        : true;

  const update = (patch: Partial<ApiKeyAuthoringDraft>) => {
    if ("operationsScope" in patch || "selectedOperations" in patch) {
      setOperationsTouched(true);
    }
    setDraft((current) => ({ ...current, ...patch }));
  };

  const submit = () => {
    startTransition(async () => {
      const result = await saveApiKeyAuthoringAction({ mode, keyId: initialKey?.id, draft });
      if (!result.ok) {
        toast.error(result.message, { position: "bottom-right" });
        return;
      }
      toast.success(result.message, { position: "bottom-right" });
      if (mode === "create" && selectedProjectId) {
        completeQuickStartStep(quickStartKey(dashboardCacheScope), "api-key");
      }
      router.push(href(API_KEYS_PATH));
      router.refresh();
    });
  };

  const handlePrimary = () => {
    if (!canContinue || isPending) return;
    if (currentStep !== "review") {
      setCurrentStep(API_KEY_AUTHORING_STEPS[currentStepIndex + 1]);
      return;
    }
    submit();
  };

  const handleBack = () => {
    if (currentStepIndex === 0) {
      router.push(href(API_KEYS_PATH));
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
              <AccessStep
                draft={draft}
                wallets={wallets}
                walletSelectionTouched={walletSelectionTouched}
                onWalletSelectionTouched={() => setWalletSelectionTouched(true)}
                operationsTouched={operationsTouched}
                update={update}
              />
            ) : null}
            {currentStep === "review" ? <ReviewStep draft={draft} wallets={wallets} /> : null}
          </div>
          <KeySummary draft={draft} wallets={wallets} environment={environment} />
        </div>
      </div>
      <div className="shrink-0 border-t border-border-default px-4 py-4 md:px-6">
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
    </div>
  );
}
