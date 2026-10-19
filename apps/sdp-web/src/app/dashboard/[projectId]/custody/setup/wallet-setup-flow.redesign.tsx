"use client";

import {
  type ByokCustodyProvider,
  CUSTODY_MODES,
  type CustodyMode,
  type CustodyWalletPurpose,
  isByokCustodyProvider,
  type SdpEnvironment,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import {
  type ComponentProps,
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  createCustodySetupWalletAction,
  initializeCustodySetupAction,
} from "@/app/dashboard/[projectId]/custody/actions";
import type { CustodyConnectionListItem } from "@/app/dashboard/[projectId]/custody/connections/connections.data";
import { custodyQueryKeys } from "@/app/dashboard/[projectId]/custody/custody-query-key";
import type { KnownCustodyProvider } from "@/app/dashboard/[projectId]/custody/provider-catalog";
import {
  type CustodyProviderAvailability,
  resolveCustodyProviderAvailability,
} from "@/app/dashboard/[projectId]/custody/provider-display-status";
import { PrivyCredentialForm } from "@/app/dashboard/[projectId]/custody/setup/privy-credential-form";
import { useWalletInventoryRefresh } from "@/app/dashboard/[projectId]/custody/use-wallet-inventory-refresh";
import { WalletProviderMark } from "@/app/dashboard/[projectId]/custody/wallet-provider-mark";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { WizardFrame } from "@/components/wizard-frame";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { recordQuickStartStep } from "@/lib/dashboard-quick-start.redesign";
import type {
  AvailableCustodyModes,
  ProjectCustodyAvailability,
} from "@/lib/provider-availability";
import { useActionIdempotencyKey } from "@/lib/use-action-idempotency-key";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";

type SetupStep = "provider" | "details";

const SETUP_STEPS = ["provider", "details"] as const satisfies readonly SetupStep[];
const PROVIDER_FORM_ID = "wallet-provider-form";
const DETAILS_FORM_ID = "wallet-details-form";
const WALLET_TARGET_FIELD = "walletTarget";
const MANAGED_WALLET_TARGET = "managed";
const ENVIRONMENT_LABEL_KEYS = {
  sandbox: "DashboardCustody.sandbox",
  production: "DashboardCustody.production",
} as const satisfies Record<SdpEnvironment, MessageKey>;
const CUSTODY_MODE_LABEL_KEYS = {
  managed: "DashboardCustody.walletSetupModeManaged",
  byok: "DashboardCustody.walletSetupModeByok",
} as const satisfies Record<CustodyMode, MessageKey>;

/** The purposes the create endpoint accepts, in the order the picker lists them. */
const WALLET_PURPOSES = [
  { value: "root", labelKey: "DashboardCustody.rootWallet" },
  { value: "transfer", labelKey: "DashboardCustody.transfers" },
  { value: "mint_authority", labelKey: "DashboardCustody.mintAuthority" },
  { value: "freeze_authority", labelKey: "DashboardCustody.freezeAuthority" },
  { value: "fee_payer", labelKey: "DashboardCustody.feePayer" },
] as const satisfies readonly { value: CustodyWalletPurpose; labelKey: MessageKey }[];

// Keep Enter available to controls that own it (newlines, option selection,
// navigation, and action buttons). A provider radio is not one of them: Enter
// on the step is Continue, as it is from anywhere else in the form.
function ignoresEnterToSubmit(target: HTMLElement): boolean {
  if (target.closest('[data-wallet-enter-advance="true"]')) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tagName = target.tagName;
  if (
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    tagName === "A" ||
    tagName === "SUMMARY" ||
    tagName === "BUTTON"
  ) {
    return true;
  }
  const role = target.getAttribute("role");
  if (
    role === "button" ||
    role === "combobox" ||
    role === "listbox" ||
    role === "option" ||
    role === "menu" ||
    role === "menuitem"
  ) {
    return true;
  }
  return target.getAttribute("aria-haspopup") !== null;
}

interface WalletSetupFlowProps {
  connectedProviders: KnownCustodyProvider[];
  /** The custody providers the project can use, each with the modes it may be set up in. */
  custodyAvailability: ProjectCustodyAvailability[];
  environment: SdpEnvironment;
  initialProvider: KnownCustodyProvider | null;
  /**
   * Connections the wallet can be created in. Offered only for a provider whose
   * modes include `byok`, and empty whenever the project has none or the reader
   * lacks `custody:admin`; in each case the wizard keeps its Managed shape.
   */
  connections: CustodyConnectionListItem[];
}

/**
 * Narrows a select value to a custody mode.
 *
 * @param value - The value the mode select reported.
 * @returns True when `value` is one of `CUSTODY_MODES`.
 */
function isCustodyMode(value: string | null): value is CustodyMode {
  return CUSTODY_MODES.some((mode) => mode === value);
}

/**
 * The mode a provider that is not set up yet gets set up in: its only mode, or the user's
 * choice when it offers more than one.
 *
 * @param input - What the selected provider offers and what the user chose.
 * @returns The setup mode, or `null` while the user still has to choose.
 */
function resolveSetupMode(input: {
  modes: AvailableCustodyModes;
  chosenMode: CustodyMode | null;
}): CustodyMode | null {
  const [firstMode, ...otherModes] = input.modes;
  return otherModes.length === 0 ? firstMode : input.chosenMode;
}

/** Only an active connection holds verified credentials, so only it can take a wallet. */
function isSelectableConnection(connection: CustodyConnectionListItem): boolean {
  return connection.status === "active";
}

/**
 * Moves the picker's choice onto the field the create action reads: a connection id as
 * `connectionId`, and Managed as no connection at all, so the action names the provider's
 * Managed config.
 *
 * @param formData - The submitted details form, edited in place.
 * @returns False when the user has not picked where the wallet lives.
 */
function applyWalletTarget(formData: FormData): boolean {
  const walletTarget = formData.get(WALLET_TARGET_FIELD);
  formData.delete(WALLET_TARGET_FIELD);
  if (typeof walletTarget !== "string" || walletTarget === "") {
    return false;
  }
  if (walletTarget !== MANAGED_WALLET_TARGET) {
    formData.set("connectionId", walletTarget);
  }
  return true;
}

/** A field label with its info hint, as the design sets every question. */
function FieldLabel({ htmlFor, label, hint }: { htmlFor?: string; label: string; hint: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      <InfoHint text={hint} />
    </div>
  );
}

/**
 * Picks the provider account a new wallet is created in: the provider's Managed config, when
 * the project has one, or one of its connections.
 *
 * Nothing is preselected. There is no default custody, so the user names the account every
 * time, even when only one is selectable.
 *
 * Unusable connections stay on the list, disabled and annotated, rather than
 * being filtered out: a user who came here to add a wallet to the connection
 * they just set up needs to see that it is there but not ready yet, not to
 * find it missing.
 */
function WalletConnectionField({
  connections,
  hasManagedConfig,
  t,
}: {
  connections: CustodyConnectionListItem[];
  hasManagedConfig: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const annotate = (connection: CustodyConnectionListItem): string | null => {
    if (isSelectableConnection(connection)) {
      return null;
    }
    return connection.status === "failed"
      ? t("DashboardCustody.walletSetupConnectionUnavailableFailed")
      : t("DashboardCustody.walletSetupConnectionUnavailablePending");
  };

  return (
    <div className="space-y-2">
      <FieldLabel
        label={t("DashboardCustody.walletSetupConnection")}
        hint={t("DashboardCustody.walletSetupConnectionHint")}
      />
      <Select
        name={WALLET_TARGET_FIELD}
        ariaLabel={t("DashboardCustody.walletSetupConnection")}
        placeholder={t("DashboardCustody.walletSetupConnectionPlaceholder")}
        size="xl"
      >
        {hasManagedConfig ? (
          <SelectItem value={MANAGED_WALLET_TARGET}>
            {t("DashboardCustody.walletSetupConnectionManaged")}
          </SelectItem>
        ) : null}
        {connections.map((connection) => {
          const annotation = annotate(connection);
          return (
            <SelectItem
              key={connection.id}
              value={connection.id}
              disabled={!isSelectableConnection(connection)}
            >
              {annotation ? `${connection.label} · ${annotation}` : connection.label}
            </SelectItem>
          );
        })}
      </Select>
    </div>
  );
}

/** Step 1: the usable providers as one radio list, then the ones still to be set up. */
function ProviderStep({
  availability,
  selectedProvider,
  onSelect,
  onSubmit,
  t,
}: {
  availability: CustodyProviderAvailability[];
  selectedProvider: KnownCustodyProvider | null;
  onSelect: (provider: KnownCustodyProvider) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  // The list holds only the providers the project can use (an unavailable one is hidden, not
  // shown disabled). Connected providers lead; the catalog's order holds within each group.
  const choices = [...availability].sort(
    (a, b) => Number(b.status === "active") - Number(a.status === "active")
  );

  return (
    <form id={PROVIDER_FORM_ID} onSubmit={onSubmit}>
      {choices.length > 0 ? (
        <fieldset>
          <legend className="sr-only">{t("DashboardCustody.walletSetupProviderTitle")}</legend>
          <div
            className="overflow-hidden rounded-card border border-border-default bg-surface-tile"
            data-wallet-provider-list
          >
            {choices.map((provider, index) => {
              const selected = selectedProvider === provider.entry.id;
              return (
                <label
                  key={provider.entry.id}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3",
                    index > 0 && "border-t border-border-subtle",
                    "cursor-pointer"
                  )}
                  data-wallet-provider={provider.entry.id}
                >
                  <input
                    type="radio"
                    name="provider"
                    value={provider.entry.id}
                    checked={selected}
                    onChange={() => onSelect(provider.entry.id)}
                    className="peer sr-only"
                    aria-describedby={`wallet-provider-${provider.entry.id}-description`}
                  />
                  <span className="inline-flex">
                    <WalletProviderMark provider={provider.entry.id} size="row" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-nav leading-4.5 text-primary">
                      {provider.entry.label}
                    </span>
                    <span
                      id={`wallet-provider-${provider.entry.id}-description`}
                      className="block text-body leading-4.5 text-secondary"
                    >
                      {t(provider.entry.descriptionKey)}
                    </span>
                  </span>
                  {provider.status === "active" ? (
                    <span className="shrink-0 text-body text-tertiary">
                      {t("DashboardCustody.active")}
                    </span>
                  ) : null}
                  {/* The visible radio: a ring, filled to a thick ink ring when chosen. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 rounded-full border border-border-strong transition-[border-width] motion-reduce:transition-none",
                      "peer-checked:border-[5px] peer-checked:border-primary",
                      "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary"
                    )}
                  />
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : (
        <p role="status" className="text-body text-secondary">
          {t("DashboardCustody.walletCreationAvailable")}
        </p>
      )}
    </form>
  );
}

/**
 * Picks how a provider the project may set up either way is set up: Managed on the deployment's
 * provider account, or BYOK on the project's own credentials. Nothing is preselected.
 */
function CustodyModeField({
  disabled,
  mode,
  modes,
  onModeChange,
  t,
}: {
  disabled: boolean;
  mode: CustodyMode | null;
  modes: AvailableCustodyModes;
  onModeChange: (mode: CustodyMode | null) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const selectId = useId();
  return (
    <div className="mb-6 space-y-2">
      <FieldLabel
        htmlFor={selectId}
        label={t("DashboardCustody.walletSetupMode")}
        hint={t("DashboardCustody.walletSetupModeHint")}
      />
      <Select
        id={selectId}
        ariaLabel={t("DashboardCustody.walletSetupMode")}
        placeholder={t("DashboardCustody.walletSetupModePlaceholder")}
        size="xl"
        value={mode}
        onValueChange={(value) => onModeChange(isCustodyMode(value) ? value : null)}
        disabled={disabled}
      >
        {modes.map((option) => (
          <SelectItem key={option} value={option}>
            {t(CUSTODY_MODE_LABEL_KEYS[option])}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
}

/** The credential form a BYOK provider is set up with. */
function ByokCredentialForm({
  provider,
  formId,
  onPendingChange,
  onRecoveryLockChange,
}: {
  provider: ByokCustodyProvider;
  formId: string;
  onPendingChange: (pending: boolean) => void;
  onRecoveryLockChange: (locked: boolean) => void;
}) {
  switch (provider) {
    case "privy":
      return (
        <PrivyCredentialForm
          formId={formId}
          onPendingChange={onPendingChange}
          onRecoveryLockChange={onRecoveryLockChange}
        />
      );
    default: {
      const unhandledProvider: never = provider;
      throw new Error(`Unhandled BYOK custody provider: ${String(unhandledProvider)}`);
    }
  }
}

interface SetupOptions {
  /** The BYOK provider whose credential form step 2 shows, or `null` when it shows none. */
  byokSetupProvider: ByokCustodyProvider | null;
  connectionOptions: CustodyConnectionListItem[];
  hasManagedConfig: boolean;
  isConnected: boolean;
  setupMode: CustodyMode | null;
  /** The modes the user picks between, or `null` when the wizard picks the mode itself. */
  modeChoices: AvailableCustodyModes | null;
}

/**
 * What step 2 offers for the selected provider, from its modes, its Managed config and the
 * project's connections. Managed is offered only where the modes include `managed`; connections
 * are BYOK custody, so a provider whose modes leave out `byok` offers none.
 *
 * Switching provider on step 1 must not carry the previous provider's connections into step 2,
 * so the list is narrowed here rather than trusted as delivered. The availability status comes
 * from Managed configs; a BYOK-only project has none, so an active connection also shows the
 * provider is installed. Without either, the wizard sets the provider up first.
 */
function resolveSetupOptions(input: {
  selectedAvailability: CustodyProviderAvailability | null;
  connections: CustodyConnectionListItem[];
  chosenMode: CustodyMode | null;
}): SetupOptions {
  const { selectedAvailability, connections, chosenMode } = input;
  if (selectedAvailability === null) {
    return {
      byokSetupProvider: null,
      connectionOptions: [],
      hasManagedConfig: false,
      isConnected: false,
      setupMode: null,
      modeChoices: null,
    };
  }
  const offersManaged = selectedAvailability.modes.includes("managed");
  const offersByok = selectedAvailability.modes.includes("byok");
  const connectionOptions = offersByok
    ? connections.filter((connection) => connection.provider === selectedAvailability.entry.id)
    : [];
  const hasManagedConfig = offersManaged && selectedAvailability.status === "active";
  const isConnected = hasManagedConfig || connectionOptions.some(isSelectableConnection);
  const setupMode = resolveSetupMode({ modes: selectedAvailability.modes, chosenMode });
  const providerId = selectedAvailability.entry.id;
  return {
    byokSetupProvider:
      !isConnected && setupMode === "byok" && isByokCustodyProvider(providerId) ? providerId : null,
    connectionOptions,
    hasManagedConfig,
    isConnected,
    setupMode,
    modeChoices: !isConnected && offersManaged && offersByok ? selectedAvailability.modes : null,
  };
}

/** Step 2 for a provider that can take a wallet now: the questions, then what it is created in. */
function DetailsStep({
  connectionOptions,
  environment,
  errorMessage,
  hasManagedConfig,
  notice,
  isConnected,
  onChangeProvider,
  onSubmit,
  onWalletLabelChange,
  providerEntry,
  showConnectionPicker,
  t,
  walletLabel,
}: {
  connectionOptions: CustodyConnectionListItem[];
  environment: SdpEnvironment;
  errorMessage: string | null;
  hasManagedConfig: boolean;
  /** Why the wallet cannot be created here, when it cannot: not a failure, so not an alert. */
  notice: string | null;
  isConnected: boolean;
  onChangeProvider: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onWalletLabelChange: (value: string) => void;
  providerEntry: { id: KnownCustodyProvider; label: string } | null;
  showConnectionPicker: boolean;
  t: ReturnType<typeof useTranslations>;
  walletLabel: string;
}) {
  const { projects, selectedProjectId } = useDashboardWorkspace();
  const cluster = useSolanaCluster();
  const projectName =
    projects.find((project) => project.id === selectedProjectId)?.name ??
    t("DashboardCustody.projectValue");
  const environmentLabel = `${t(ENVIRONMENT_LABEL_KEYS[environment])} · ${
    cluster === "mainnet-beta" ? "mainnet" : cluster
  }`;

  return (
    <form id={DETAILS_FORM_ID} onSubmit={onSubmit}>
      <input type="hidden" name="provider" value={providerEntry?.id ?? ""} />
      <div className="space-y-6">
        <div className="space-y-2">
          <FieldLabel
            htmlFor="wallet-label"
            label={t("DashboardCustody.walletLabel")}
            hint={t("DashboardCustody.walletLabelHint")}
          />
          <Input
            id="wallet-label"
            name={isConnected ? "label" : "walletLabel"}
            size="xl"
            value={walletLabel}
            onChange={(event) => onWalletLabelChange(event.currentTarget.value)}
            placeholder={t("DashboardCustody.newDesign.walletLabelPlaceholder")}
            maxLength={100}
            required
          />
        </div>
        <div className="space-y-2">
          <FieldLabel
            label={t("DashboardCustody.purpose")}
            hint={
              isConnected
                ? t("DashboardCustody.walletPurposeHint")
                : t("DashboardCustody.walletPurposeFirstWalletHint")
            }
          />
          {/* The first wallet on a provider is created with the provider and is always its root
              wallet, so there is nothing to choose until the provider is connected. */}
          <Select
            name={isConnected ? "purpose" : undefined}
            ariaLabel={t("DashboardCustody.purpose")}
            defaultValue="root"
            disabled={!isConnected}
            size="xl"
          >
            {WALLET_PURPOSES.map((purpose) => (
              <SelectItem key={purpose.value} value={purpose.value}>
                {t(purpose.labelKey)}
              </SelectItem>
            ))}
          </Select>
        </div>
        {showConnectionPicker ? (
          <WalletConnectionField
            connections={connectionOptions}
            hasManagedConfig={hasManagedConfig}
            t={t}
          />
        ) : null}
      </div>

      <section className="mt-8" aria-labelledby="wallet-created-with">
        <h3 id="wallet-created-with" className="text-nav font-medium text-primary">
          {t("DashboardCustody.walletSetupCreatedWith")}
        </h3>
        <dl className="mt-2">
          <div className="flex h-12 items-center justify-between gap-4 border-b border-border-subtle">
            <dt className="text-body text-secondary">
              {t("DashboardCustody.walletSetupProvider")}
            </dt>
            <dd className="flex items-center gap-4 text-body text-primary">
              {providerEntry?.label}
              <button
                type="button"
                onClick={onChangeProvider}
                className="text-tertiary underline-offset-4 transition-colors hover:text-primary hover:underline"
              >
                {t("DashboardCustody.walletSetupChangeProvider")}
              </button>
            </dd>
          </div>
          <div className="flex h-12 items-center justify-between gap-4 border-b border-border-subtle">
            <dt className="flex items-center gap-1.5 text-body text-secondary">
              {t("DashboardCustody.project")}
              <InfoHint text={t("DashboardCustody.walletSetupProjectHint")} />
            </dt>
            <dd className="min-w-0 truncate text-body text-primary">{projectName}</dd>
          </div>
          <div className="flex h-12 items-center justify-between gap-4">
            <dt className="flex items-center gap-1.5 text-body text-secondary">
              {t("DashboardCustody.environment")}
              <InfoHint text={t("DashboardCustody.walletSetupEnvironmentHint")} />
            </dt>
            <dd className="text-body text-primary">{environmentLabel}</dd>
          </div>
        </dl>
      </section>

      {notice ? <p className="mt-6 text-body text-secondary">{notice}</p> : null}
      {errorMessage ? (
        <p role="alert" className="mt-6 text-body text-error">
          {errorMessage}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Step 2 of the flow: the custody mode question where the provider offers more than one, then
 * the BYOK credential form, or the wallet details once there is nothing left to choose.
 */
function DetailsPhase({
  awaitingModeChoice,
  byokRecoveryLocked,
  byokSetupProvider,
  chosenMode,
  detailsStep,
  isByokDetails,
  modeChoices,
  onByokPendingChange,
  onModeChange,
  onRecoveryLockChange,
  setupRequestInFlight,
  t,
}: {
  awaitingModeChoice: boolean;
  byokRecoveryLocked: boolean;
  byokSetupProvider: ByokCustodyProvider | null;
  chosenMode: CustodyMode | null;
  detailsStep: ComponentProps<typeof DetailsStep>;
  isByokDetails: boolean;
  modeChoices: AvailableCustodyModes | null;
  onByokPendingChange: (pending: boolean) => void;
  onModeChange: (mode: CustodyMode | null) => void;
  onRecoveryLockChange: (locked: boolean) => void;
  setupRequestInFlight: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <>
      {modeChoices === null ? null : (
        <CustodyModeField
          disabled={byokRecoveryLocked || setupRequestInFlight}
          mode={chosenMode}
          modes={modeChoices}
          onModeChange={onModeChange}
          t={t}
        />
      )}
      {byokSetupProvider === null ? null : (
        <ByokCredentialForm
          provider={byokSetupProvider}
          formId={DETAILS_FORM_ID}
          onPendingChange={onByokPendingChange}
          onRecoveryLockChange={onRecoveryLockChange}
        />
      )}
      {isByokDetails || awaitingModeChoice ? null : <DetailsStep {...detailsStep} />}
    </>
  );
}

/**
 * The footer band. Step 1: Cancel and Continue. Step 2: Back, what confirming does, Cancel and
 * Create. A primary action that cannot run yet is outlined, as the design draws it. The Privy
 * credential form carries its own submit, and a submission in an unknown state locks the way out.
 */
function SetupFooter({
  step,
  providerLabel,
  canCreate,
  isPending,
  isLocked,
  ownsSubmit,
  recoveryLocked,
  onBack,
  onCancel,
  t,
}: {
  step: SetupStep;
  providerLabel: string | null;
  canCreate: boolean;
  isPending: boolean;
  /** A setup request is in flight (Managed or BYOK): the way back and out waits for it. */
  isLocked: boolean;
  ownsSubmit: boolean;
  recoveryLocked: boolean;
  onBack: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  if (step === "provider") {
    return (
      <div className="flex items-center justify-end gap-4">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("DashboardCustody.cancel")}
        </Button>
        <Button
          type="submit"
          form={PROVIDER_FORM_ID}
          variant={providerLabel ? "default" : "outline"}
          disabled={!providerLabel}
        >
          {t("DashboardCustody.continue")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      {recoveryLocked ? null : (
        <Button type="button" variant="outline" onClick={onBack} disabled={isLocked}>
          {t("DashboardCustody.back")}
        </Button>
      )}
      {ownsSubmit && providerLabel ? (
        <p className="min-w-0 flex-1 text-body text-secondary">
          {t("DashboardCustody.walletSetupConfirmHint", { provider: providerLabel })}
        </p>
      ) : null}
      <div className="ml-auto flex items-center gap-4">
        {recoveryLocked ? null : (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isLocked}>
            {t("DashboardCustody.cancel")}
          </Button>
        )}
        {ownsSubmit ? (
          <Button
            type="submit"
            form={DETAILS_FORM_ID}
            variant={canCreate ? "default" : "outline"}
            disabled={!canCreate}
          >
            {isPending
              ? t("DashboardCustody.createWalletPending")
              : t("DashboardCustody.createWallet")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function getInitialSelection(input: {
  availability: CustodyProviderAvailability[];
  initialProvider: KnownCustodyProvider | null;
}): {
  provider: KnownCustodyProvider | null;
  step: SetupStep;
} {
  const { availability, initialProvider } = input;
  const requested = initialProvider
    ? availability.find((provider) => provider.entry.id === initialProvider)
    : undefined;

  if (requested) {
    return {
      provider: requested.entry.id,
      step: "details",
    };
  }

  return {
    provider: null,
    step: "provider",
  };
}

/** Why step 2 cannot create a wallet: the provider holds one already, or none is chosen. */
function provisioningNotice(
  providerLabel: string | null,
  t: ReturnType<typeof useTranslations>
): string {
  return providerLabel
    ? t("DashboardCustody.connectedProviderDescription", { provider: providerLabel })
    : t("DashboardCustody.chooseEnabledProvider");
}

/**
 * Enter anywhere in the flow submits the step's form, as its primary button would, except
 * where Enter already means something (a textarea, a button, a link).
 */
function useEnterSubmitsStep(formId: string) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "Enter" ||
        event.repeat ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        event.defaultPrevented
      ) {
        return;
      }
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        !target.closest("[data-wallet-setup-flow]") ||
        ignoresEnterToSubmit(target)
      ) {
        return;
      }

      event.preventDefault();
      const form = document.getElementById(formId);
      if (form instanceof HTMLFormElement) {
        form.requestSubmit();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [formId]);
}

/**
 * Submits the details form: checks it, names where the wallet lives, runs the create or initialize
 * action, and on success marks the quick-start step and returns to the project's wallet list.
 * A refusal lands in `setErrorMessage`.
 */
function useCreateWallet({
  canSubmit,
  formAction,
  setErrorMessage,
  showConnectionPicker,
}: {
  canSubmit: boolean;
  formAction: typeof createCustodySetupWalletAction | typeof initializeCustodySetupAction;
  setErrorMessage: (message: string | null) => void;
  showConnectionPicker: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const href = useProjectHref();
  const refreshWalletInventory = useWalletInventoryRefresh();
  const { dashboardCacheScope, flags, selectedProjectId } = useDashboardWorkspace();
  const [isPending, startTransition] = useTransition();
  const submissionInFlightRef = useRef(false);
  const setupKey = useActionIdempotencyKey(custodyQueryKeys.isWalletInventoryKey);

  const createWallet = (form: HTMLFormElement) => {
    if (submissionInFlightRef.current || !form.reportValidity() || !canSubmit || isPending) {
      return;
    }

    const formData = new FormData(form);
    if (showConnectionPicker && !applyWalletTarget(formData)) {
      setErrorMessage(t("DashboardCustody.walletSetupConnectionRequired"));
      return;
    }

    submissionInFlightRef.current = true;
    setErrorMessage(null);
    // One key per submitted setup: the same details keep it across retries.
    // The project is part of it: a setup's key is the API's per project, so a
    // lost answer in one project is never settled by the same form in another.
    const input = JSON.stringify([
      selectedProjectId,
      formAction === initializeCustodySetupAction,
      [...formData.entries()].map(([k, v]) => [k, String(v)]),
    ]);
    const key = setupKey.keyFor(input);
    formData.set("idempotencyKey", key);

    startTransition(async () => {
      try {
        let result: Awaited<ReturnType<typeof formAction>>;
        try {
          result = await formAction(formData);
        } catch {
          // No answer: the call may have reached the server. The key stays and the form stays,
          // so Create wallet again resends the same request under the same key.
          setupKey.settled(input, key, { status: "error" });
          // The wallet may exist: the inventory is refreshed so the list shows it.
          refreshWalletInventory();
          setErrorMessage(t("DashboardCustody.walletSetupOutcomeUnknown"));
          return;
        }
        setupKey.settled(input, key, result);

        switch (result.status) {
          case "error":
            // A refusal may follow an earlier attempt that did create the
            // wallet, so the inventory is refreshed before the user retries.
            refreshWalletInventory();
            setErrorMessage(result.message);
            return;
          case "provider_already_set_up":
            setErrorMessage(t("DashboardCustody.walletSetupProviderAlreadySetUp"));
            router.refresh();
            return;
          case "success":
            break;
          default: {
            const unhandledResult: never = result;
            throw new Error(`Unhandled wallet setup result: ${JSON.stringify(unhandledResult)}`);
          }
        }

        if (selectedProjectId) {
          recordQuickStartStep(flags, dashboardCacheScope, "wallet");
        }
        refreshWalletInventory();
        router.refresh();
        router.push(href("/dashboard/wallets"));
      } finally {
        submissionInFlightRef.current = false;
      }
    });
  };

  return { createWallet, isPending };
}

// react-doctor-disable-next-line no-high-complexity-react-function -- the same two-step wizard state as the previous design's flow (provider, custody mode, details); its submit handling and step 2 are already their own hook and component
export function WalletSetupFlow({
  connectedProviders,
  custodyAvailability,
  environment,
  initialProvider,
  connections,
}: WalletSetupFlowProps) {
  const t = useTranslations();
  const router = useRouter();
  const href = useProjectHref();
  const availability = useMemo(
    () => resolveCustodyProviderAvailability({ connectedProviders, custodyAvailability }),
    [connectedProviders, custodyAvailability]
  );
  const initialSelection = useMemo(
    () =>
      getInitialSelection({
        availability,
        initialProvider,
      }),
    [availability, initialProvider]
  );
  const [currentStep, setCurrentStep] = useState<SetupStep>(initialSelection.step);
  const [selectedProvider, setSelectedProvider] = useState<KnownCustodyProvider | null>(
    initialSelection.provider
  );
  const [walletLabel, setWalletLabel] = useState("");
  const [chosenMode, setChosenMode] = useState<CustodyMode | null>(null);
  // While a BYOK submission is in an unknown state, leaving the step would
  // unmount the frozen payload and key that are the only path to recovery.
  const [byokRecoveryLocked, setByokRecoveryLocked] = useState(false);
  const [byokRequestPending, setByokRequestPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedAvailability = useMemo(() => {
    const match = availability.find((provider) => provider.entry.id === selectedProvider);
    return match === undefined ? null : match;
  }, [availability, selectedProvider]);
  const selectedProviderEntry = selectedAvailability === null ? null : selectedAvailability.entry;
  const {
    byokSetupProvider,
    connectionOptions,
    hasManagedConfig,
    isConnected,
    setupMode,
    modeChoices,
  } = useMemo(
    () => resolveSetupOptions({ selectedAvailability, connections, chosenMode }),
    [selectedAvailability, connections, chosenMode]
  );
  const awaitingModeChoice = modeChoices !== null && setupMode === null;
  const canProvisionWallet =
    selectedProviderEntry !== null &&
    (isConnected ? selectedProviderEntry.supportsAdditionalWallets : setupMode === "managed");
  const formAction = isConnected ? createCustodySetupWalletAction : initializeCustodySetupAction;
  const showConnectionPicker = isConnected && connectionOptions.some(isSelectableConnection);
  const { createWallet, isPending } = useCreateWallet({
    canSubmit: canProvisionWallet && selectedProviderEntry !== null,
    formAction,
    setErrorMessage,
    showConnectionPicker,
  });
  // A BYOK setup goes through provider details (credential submission + connection check)
  // instead of the Managed initialize path.
  const isByokDetails = byokSetupProvider !== null;
  // Every setup request, Managed or BYOK, holds the mode picker and Back: a BYOK request
  // settling after its form unmounted could lock recovery with no form left to recover from.
  const setupRequestInFlight = isPending || byokRequestPending;
  const canCreate = canProvisionWallet && walletLabel.trim().length > 0 && !isPending;

  const leaveFlow = () => router.push(href("/dashboard/wallets"));

  const goToProviderStep = () => {
    setErrorMessage(null);
    setCurrentStep("provider");
  };

  const handleProviderSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProviderEntry) {
      return;
    }
    setCurrentStep("details");
  };

  const handleDetailsSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    createWallet(event.currentTarget);
  };

  useEnterSubmitsStep(currentStep === "provider" ? PROVIDER_FORM_ID : DETAILS_FORM_ID);

  const stepIndex = SETUP_STEPS.indexOf(currentStep);
  const steps = [
    {
      label: t("DashboardCustody.walletSetupProviderStep"),
      title: t("DashboardCustody.walletSetupProviderTitle"),
    },
    {
      label: t("DashboardCustody.walletSetupDetailsStep"),
      title: isByokDetails
        ? t("DashboardCustody.byokProviderDetails")
        : t("DashboardCustody.walletDetails"),
    },
  ];

  const footer = (
    <SetupFooter
      step={currentStep}
      providerLabel={selectedProviderEntry?.label ?? null}
      canCreate={canCreate}
      isPending={isPending}
      isLocked={setupRequestInFlight}
      ownsSubmit={!isByokDetails}
      recoveryLocked={byokRecoveryLocked}
      onBack={goToProviderStep}
      onCancel={leaveFlow}
      t={t}
    />
  );

  return (
    <div className="h-full min-h-0" data-wallet-setup-flow="true">
      <WizardFrame
        steps={steps}
        currentStep={stepIndex}
        progressLabel={t("DashboardCustody.stepOf", {
          current: stepIndex + 1,
          total: SETUP_STEPS.length,
        })}
        description={
          currentStep === "provider" ? t("DashboardCustody.walletSetupProviderDescription") : null
        }
        footer={footer}
      >
        {currentStep === "provider" ? (
          <ProviderStep
            availability={availability}
            selectedProvider={selectedProvider}
            onSelect={(provider) => {
              setSelectedProvider(provider);
              setChosenMode(null);
              setErrorMessage(null);
            }}
            onSubmit={handleProviderSubmit}
            t={t}
          />
        ) : (
          <DetailsPhase
            awaitingModeChoice={awaitingModeChoice}
            byokRecoveryLocked={byokRecoveryLocked}
            byokSetupProvider={byokSetupProvider}
            chosenMode={chosenMode}
            detailsStep={{
              connectionOptions,
              environment,
              errorMessage,
              hasManagedConfig,
              notice: canProvisionWallet
                ? null
                : provisioningNotice(selectedProviderEntry?.label ?? null, t),
              isConnected,
              onChangeProvider: goToProviderStep,
              onSubmit: handleDetailsSubmit,
              onWalletLabelChange: setWalletLabel,
              providerEntry: selectedProviderEntry,
              showConnectionPicker,
              t,
              walletLabel,
            }}
            isByokDetails={isByokDetails}
            modeChoices={modeChoices}
            onByokPendingChange={setByokRequestPending}
            onModeChange={(mode) => {
              setChosenMode(mode);
              setErrorMessage(null);
            }}
            onRecoveryLockChange={setByokRecoveryLocked}
            setupRequestInFlight={setupRequestInFlight}
            t={t}
          />
        )}
      </WizardFrame>
    </div>
  );
}
