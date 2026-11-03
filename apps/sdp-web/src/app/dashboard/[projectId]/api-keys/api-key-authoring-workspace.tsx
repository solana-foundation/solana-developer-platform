"use client";

import type { Action } from "@sdp/types/actions";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { DateTimePicker } from "@sdp/ui/date-picker";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Textarea } from "@sdp/ui/textarea";
import { CircleCheck, FileText, Globe, KeyRound, Layers, Search, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { invalidateQuickStartStatus } from "@/lib/dashboard-quick-start";
import { parseAllowedIps } from "@/lib/ip-allowlist-input";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { saveApiKeyAuthoringAction } from "./actions";
import {
  API_KEY_AUTHORING_STEPS,
  type ApiKeyAuthoringDraft,
  type ApiKeyAuthoringExistingKey,
  type ApiKeyAuthoringMode,
  type ApiKeyAuthoringStep,
  createApiKeyAuthoringDraft,
  defaultWalletScopeForGrants,
  isAuthoringStepComplete,
} from "./api-key-authoring";
import { grantSummaryLines, grantsSummaryLabel } from "./api-key-grant-labels";
import { ApiKeyGrantPicker } from "./api-key-grant-picker";

const API_KEYS_PATH = "/dashboard/api-keys";

interface ApiKeyAuthoringWorkspaceProps {
  mode: ApiKeyAuthoringMode;
  wallets: PaymentsDashboardWallet[];
  /** The actions this deployment's release channel lets a key hold. */
  offeredActions: Action[];
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
  return {
    ...empty,
    name: initialKey.name,
    expiresAt: toLocalDateTime(initialKey.expiresAt),
    walletScope: initialKey.walletScope,
    selectedWalletIds: initialKey.walletIds,
    grants: initialKey.grants,
    allowedIps: (initialKey.allowedIps ?? []).join("\n"),
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

/** The key's grants, one module per line. */
function GrantSummaryList({ grants }: { grants: readonly Action[] }) {
  const t = useTranslations();
  const lines = grantSummaryLines(grants, t);
  if (lines.length === 0) {
    return <p className="text-sm text-secondary">{t("DashboardCustody.apiKeyGrantsNone")}</p>;
  }
  return (
    <ul className="space-y-1">
      {lines.map((line) => (
        <li key={line} className="text-sm text-primary">
          {line}
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
        <WorkSection
          title={t("DashboardCustody.apiKeyNetworkAccess")}
          description={t("DashboardCustody.apiKeyNetworkAccessDescription")}
        >
          <Label htmlFor="api-key-allowed-ips">{t("DashboardCustody.apiKeyAllowedIpsLabel")}</Label>
          <Textarea
            id="api-key-allowed-ips"
            className="mt-2"
            rows={3}
            value={draft.allowedIps}
            onChange={(event) => update({ allowedIps: event.currentTarget.value })}
            placeholder={"203.0.113.10\n198.51.100.0/24"}
            aria-describedby="api-key-allowed-ips-helper"
            spellCheck={false}
          />
          <p id="api-key-allowed-ips-helper" className="mt-2 text-xs text-secondary">
            {t("DashboardCustody.apiKeyAllowedIpsHelper")}
          </p>
        </WorkSection>
      </div>
    </div>
  );
}

/** The draft's allowlist for a summary: its entries, or "any address". */
function allowedIpsLabel(draft: ApiKeyAuthoringDraft, t: ReturnType<typeof useTranslations>) {
  const entries = parseAllowedIps(draft.allowedIps);
  return entries.length > 0 ? entries.join(", ") : t("DashboardCustody.apiKeyAllowedIpsAny");
}

function PermissionsStep({
  draft,
  offeredActions,
  touched,
  update,
}: {
  draft: ApiKeyAuthoringDraft;
  offeredActions: Action[];
  touched: boolean;
  update: (patch: Partial<ApiKeyAuthoringDraft>) => void;
}) {
  const t = useTranslations();
  return (
    <div>
      <h2 className="text-2xl font-medium text-primary">
        {t("DashboardCustody.apiKeyPermissionsTitle")}
      </h2>
      <p className="mt-1.5 text-sm text-secondary">
        {t("DashboardCustody.apiKeyPermissionsDescription")}
      </p>
      <div className="mt-5 space-y-4">
        <WorkSection title={t("DashboardCustody.apiKeyGrantsReviewTitle")}>
          <ApiKeyGrantPicker
            offered={offeredActions}
            grants={draft.grants}
            touched={touched}
            onChange={(grants) => update({ grants })}
          />
        </WorkSection>
      </div>
    </div>
  );
}

function WalletRow({
  wallet,
  checked,
  onToggle,
}: {
  wallet: PaymentsDashboardWallet;
  checked: boolean;
  onToggle: () => void;
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
    </div>
  );
}

function AccessStep({
  draft,
  wallets,
  walletSelectionTouched,
  onWalletSelectionTouched,
  update,
}: {
  draft: ApiKeyAuthoringDraft;
  wallets: PaymentsDashboardWallet[];
  walletSelectionTouched: boolean;
  onWalletSelectionTouched: () => void;
  update: (patch: Partial<ApiKeyAuthoringDraft>) => void;
}) {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const selectedWallets = wallets.filter((wallet) => draft.selectedWalletIds.includes(wallet.id));
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
    update({ selectedWalletIds });
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
                      key={wallet.id}
                      wallet={wallet}
                      checked={draft.selectedWalletIds.includes(wallet.id)}
                      onToggle={() => toggleWallet(wallet.id)}
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
  const selectedWallets = wallets.filter((wallet) => draft.selectedWalletIds.includes(wallet.id));

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
          <ReviewLine
            label={t("DashboardCustody.apiKeyAllowedIps")}
            value={allowedIpsLabel(draft, t)}
          />
        </WorkSection>
        <WorkSection title={t("DashboardCustody.apiKeyReviewPermissions")}>
          <GrantSummaryList grants={draft.grants} />
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
  const selectedWallets = wallets.filter((wallet) => draft.selectedWalletIds.includes(wallet.id));

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
            icon={<Globe className="size-4" />}
            label={t("DashboardCustody.apiKeyAllowedIps")}
            value={allowedIpsLabel(draft, t)}
          />
          <SummaryRow
            icon={<KeyRound className="size-4" />}
            label={t("DashboardCustody.apiKeySummaryPermissions")}
            value={grantsSummaryLabel(draft.grants, t)}
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
        </div>
      </div>
    </aside>
  );
}

export function ApiKeyAuthoringWorkspace({
  mode,
  wallets,
  offeredActions,
  initialKey,
}: ApiKeyAuthoringWorkspaceProps) {
  const t = useTranslations();
  const router = useRouter();
  const href = useProjectHref();
  const { sdpEnvironment, selectedProjectId } = useDashboardWorkspace();
  const [currentStep, setCurrentStep] = useState<ApiKeyAuthoringStep>("details");
  const [draft, setDraft] = useState(() => draftFromInitialKey(initialKey));
  const [walletSelectionTouched, setWalletSelectionTouched] = useState(false);
  // A new key's wallet scope follows its grants until the person picks one:
  // an execute grant starts it on Selected wallets (HOO-2099).
  const [walletScopeChosen, setWalletScopeChosen] = useState(mode === "edit");
  const [grantsTouched, setGrantsTouched] = useState(false);
  const [isPending, startTransition] = useTransition();
  const environment =
    (initialKey?.environment ?? sdpEnvironment) === "production"
      ? t("DashboardCustody.production")
      : t("DashboardCustody.sandbox");
  const currentStepIndex = API_KEY_AUTHORING_STEPS.indexOf(currentStep);
  const canContinue = isAuthoringStepComplete(currentStep, draft);

  const update = (patch: Partial<ApiKeyAuthoringDraft>) => {
    if ("grants" in patch) {
      setGrantsTouched(true);
    }
    if ("walletScope" in patch) {
      setWalletScopeChosen(true);
    }
    setDraft((current) => {
      const next = { ...current, ...patch };
      return patch.grants !== undefined && !walletScopeChosen && !("walletScope" in patch)
        ? { ...next, walletScope: defaultWalletScopeForGrants(patch.grants) }
        : next;
    });
  };

  const submit = () => {
    startTransition(async () => {
      const result = await saveApiKeyAuthoringAction({
        mode,
        keyId: initialKey?.id,
        draft,
        grantsTouched,
      });
      if (!result.ok) {
        toast.error(result.message, { position: "bottom-right" });
        return;
      }
      toast.success(result.message, { position: "bottom-right" });
      if (mode === "create" && selectedProjectId) {
        invalidateQuickStartStatus();
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
              <PermissionsStep
                draft={draft}
                offeredActions={offeredActions}
                touched={grantsTouched}
                update={update}
              />
            ) : null}
            {currentStep === "wallets" ? (
              <AccessStep
                draft={draft}
                wallets={wallets}
                walletSelectionTouched={walletSelectionTouched}
                onWalletSelectionTouched={() => setWalletSelectionTouched(true)}
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
