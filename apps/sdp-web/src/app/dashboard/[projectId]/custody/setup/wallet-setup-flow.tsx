"use client";

import {
  type ByokCustodyProvider,
  CUSTODY_MODES,
  type CustodyMode,
  isByokCustodyProvider,
  type SdpEnvironment,
} from "@sdp/types";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createCustodySetupWalletAction,
  initializeCustodySetupAction,
} from "@/app/dashboard/[projectId]/custody/actions";
import type { CustodyConnectionListItem } from "@/app/dashboard/[projectId]/custody/connections/connections.data";
import type { KnownCustodyProvider } from "@/app/dashboard/[projectId]/custody/provider-catalog";
import {
  type CustodyProviderAvailability,
  resolveCustodyProviderAvailability,
} from "@/app/dashboard/[projectId]/custody/provider-display-status";
import { PrivyCredentialForm } from "@/app/dashboard/[projectId]/custody/setup/privy-credential-form";
import { useWalletInventoryRefresh } from "@/app/dashboard/[projectId]/custody/use-wallet-inventory-refresh";
import { WalletProviderChoices } from "@/app/dashboard/[projectId]/custody/wallet-provider-choices";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { completeQuickStartStep, quickStartKey } from "@/lib/dashboard-quick-start";
import type {
  AvailableCustodyModes,
  ProjectCustodyAvailability,
} from "@/lib/provider-availability";
import { useProjectHref } from "@/lib/use-dashboard-project";

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

// Keep Enter available to controls that own it (newlines, option selection,
// navigation, and action buttons). The already-selected provider card opts in
// because selecting it again is a no-op and the next useful action is Continue.
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
 * The mode a provider that is not set up yet gets set up in: its only mode,
 * or the user's choice when it offers more than one.
 *
 * @param input - What the selected provider offers and what the user chose.
 * @param input.modes - The modes the project may set the provider up in.
 * @param input.chosenMode - The mode the user picked, if any.
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
 * Moves the picker's choice onto the field the create action reads: a
 * connection id as `connectionId`, and Managed as no connection at all, so the
 * action names the provider's Managed config.
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

/**
 * Picks the provider account a new wallet is created in: the provider's
 * Managed config, when the project has one, or one of its connections.
 *
 * Nothing is preselected. There is no default custody, so the user names the
 * account every time, even when only one is selectable.
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
      <Label htmlFor="wallet-connection">{t("DashboardCustody.walletSetupConnection")}</Label>
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
      <p className="text-sm leading-6 text-tertiary">
        {t("DashboardCustody.walletSetupConnectionHint")}
      </p>
    </div>
  );
}

/** Read-only row for context the wizard states but does not let the user change. */
function WalletFixedField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex h-12 items-center rounded-2xl border border-border-default bg-fill-subtle px-4 text-sm font-medium text-primary">
        {value}
      </div>
    </div>
  );
}

/**
 * Picks how a provider the project may set up either way is set up: Managed on
 * the deployment's provider account, or BYOK on the project's own credentials.
 * Nothing is preselected.
 *
 * @param props - The component props.
 * @param props.disabled - Locks the choice while a setup request is pending or a
 *   BYOK submission awaits recovery.
 * @param props.mode - The chosen mode, or `null` before the user picks.
 * @param props.onModeChange - Called with the newly chosen mode.
 * @param props.t - The translator.
 * @returns The mode select.
 */
function CustodyModeField({
  disabled,
  mode,
  onModeChange,
  t,
}: {
  disabled: boolean;
  mode: CustodyMode | null;
  onModeChange: (mode: CustodyMode | null) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="space-y-2">
      <Label>{t("DashboardCustody.walletSetupMode")}</Label>
      <Select
        ariaLabel={t("DashboardCustody.walletSetupMode")}
        placeholder={t("DashboardCustody.walletSetupModePlaceholder")}
        size="xl"
        value={mode}
        onValueChange={(value) => onModeChange(isCustodyMode(value) ? value : null)}
        disabled={disabled}
      >
        <SelectItem value="managed">{t("DashboardCustody.walletSetupModeManaged")}</SelectItem>
        <SelectItem value="byok">{t("DashboardCustody.walletSetupModeByok")}</SelectItem>
      </Select>
      <p className="text-sm leading-6 text-tertiary">{t("DashboardCustody.walletSetupModeHint")}</p>
    </div>
  );
}

/**
 * The credential form a BYOK provider is set up with.
 *
 * @param props - The component props.
 * @param props.provider - The BYOK provider being set up.
 * @param props.formId - The id the footer's submit button targets.
 * @param props.onRecoveryLockChange - Called with whether leaving the form would strand a stored credential or key.
 * @returns The provider's credential form.
 */
function ByokCredentialForm({
  provider,
  formId,
  onRecoveryLockChange,
}: {
  provider: ByokCustodyProvider;
  formId: string;
  onRecoveryLockChange: (locked: boolean) => void;
}) {
  switch (provider) {
    case "privy":
      return <PrivyCredentialForm formId={formId} onRecoveryLockChange={onRecoveryLockChange} />;
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
  showModeChoice: boolean;
}

/**
 * What step 2 offers for the selected provider, from its modes, its Managed
 * config and the project's connections. Managed is offered only where the
 * modes include `managed`; connections are BYOK custody, so a provider whose
 * modes leave out `byok` offers none.
 *
 * Switching provider on step 1 must not carry the previous provider's
 * connections into step 2, so the list is narrowed here rather than trusted as
 * delivered. The availability status comes from Managed configs; a BYOK-only
 * project has none, so an active connection also shows the provider is
 * installed. Without either, the wizard sets the provider up first.
 *
 * @param input - The selection and the project's connections.
 * @param input.selectedAvailability - The selected provider's row, or `null` before one is picked.
 * @param input.connections - Every connection the wallet could be created in.
 * @param input.chosenMode - The mode the user picked for a provider offering both.
 * @returns The connections, setup state, mode and BYOK credential form step 2 renders from.
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
      showModeChoice: false,
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
    showModeChoice: !isConnected && offersManaged && offersByok,
  };
}

/** Step 2 of the wizard for a provider that is already installed. */
function WalletDetailsFields({
  canProvisionWallet,
  connectionOptions,
  environment,
  errorMessage,
  hasManagedConfig,
  isConnected,
  onWalletLabelChange,
  providerEntry,
  showConnectionPicker,
  t,
  walletLabel,
}: {
  canProvisionWallet: boolean;
  connectionOptions: CustodyConnectionListItem[];
  environment: SdpEnvironment;
  errorMessage: string | null;
  hasManagedConfig: boolean;
  isConnected: boolean;
  onWalletLabelChange: (value: string) => void;
  providerEntry: { id: KnownCustodyProvider; label: string } | null;
  showConnectionPicker: boolean;
  t: ReturnType<typeof useTranslations>;
  walletLabel: string;
}) {
  return (
    <>
      <input type="hidden" name="provider" value={providerEntry?.id ?? ""} />
      <div className="space-y-2">
        <Label htmlFor="wallet-label">{t("DashboardCustody.walletLabel")}</Label>
        <Input
          id="wallet-label"
          name={isConnected ? "label" : "walletLabel"}
          value={walletLabel}
          onChange={(event) => onWalletLabelChange(event.currentTarget.value)}
          placeholder={t("DashboardCustody.walletLabelPlaceholder")}
          className="h-12 rounded-2xl border-border-default bg-surface-raised px-4 shadow-none"
          required
        />
      </div>
      {showConnectionPicker ? (
        <WalletConnectionField
          connections={connectionOptions}
          hasManagedConfig={hasManagedConfig}
          t={t}
        />
      ) : null}
      <WalletFixedField
        label={t("DashboardCustody.project")}
        value={t("DashboardCustody.projectValue")}
      />
      <WalletFixedField
        label={t("DashboardCustody.environment")}
        value={t(ENVIRONMENT_LABEL_KEYS[environment])}
      />
      {canProvisionWallet ? null : (
        <div className="rounded-2xl border border-border-default bg-fill-subtle px-4 py-3 text-sm leading-6 text-tertiary">
          {providerEntry
            ? t("DashboardCustody.connectedProviderDescription", { provider: providerEntry.label })
            : t("DashboardCustody.chooseEnabledProvider")}
        </div>
      )}
      {errorMessage ? (
        <div
          role="alert"
          className="rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error"
        >
          {errorMessage}
        </div>
      ) : null}
    </>
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
  const refreshWalletInventory = useWalletInventoryRefresh();
  const { dashboardCacheScope, selectedProjectId } = useDashboardWorkspace();
  const [isPending, startTransition] = useTransition();
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submissionInFlightRef = useRef(false);

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
    showModeChoice,
  } = useMemo(
    () => resolveSetupOptions({ selectedAvailability, connections, chosenMode }),
    [selectedAvailability, connections, chosenMode]
  );
  const awaitingModeChoice = showModeChoice && setupMode === null;
  const canProvisionWallet =
    selectedProviderEntry !== null &&
    (isConnected ? selectedProviderEntry.supportsAdditionalWallets : setupMode === "managed");
  const formAction = isConnected ? createCustodySetupWalletAction : initializeCustodySetupAction;
  const showConnectionPicker = isConnected && connectionOptions.some(isSelectableConnection);
  // A BYOK setup goes through provider details (credential submission +
  // connection check) instead of the Managed initialize path.
  const isByokDetails = byokSetupProvider !== null;

  const continueFromProvider = () => {
    if (!selectedProviderEntry) {
      return;
    }
    setSelectedProvider(selectedProviderEntry.id);
    setCurrentStep("details");
  };

  const goBack = () => {
    setErrorMessage(null);
    if (currentStep === "details") {
      setCurrentStep("provider");
      return;
    }
    router.push(href("/dashboard/wallets"));
  };

  const handleProviderSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    continueFromProvider();
  };

  const handleCreateWallet = (form: HTMLFormElement) => {
    if (
      submissionInFlightRef.current ||
      !form.reportValidity() ||
      !canProvisionWallet ||
      isPending ||
      !selectedProviderEntry
    ) {
      return;
    }

    const formData = new FormData(form);
    if (showConnectionPicker && !applyWalletTarget(formData)) {
      setErrorMessage(t("DashboardCustody.walletSetupConnectionRequired"));
      return;
    }

    submissionInFlightRef.current = true;
    setErrorMessage(null);

    startTransition(async () => {
      try {
        const result = await formAction(formData);

        switch (result.status) {
          case "error":
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
          completeQuickStartStep(quickStartKey(dashboardCacheScope), "wallet");
        }
        refreshWalletInventory();
        router.refresh();
        router.push(href("/dashboard/wallets"));
      } finally {
        submissionInFlightRef.current = false;
      }
    });
  };

  const handleDetailsSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handleCreateWallet(event.currentTarget);
  };

  const currentStepSubmitRef = useRef<() => void>(() => {});
  currentStepSubmitRef.current = () => {
    const formId = currentStep === "provider" ? PROVIDER_FORM_ID : DETAILS_FORM_ID;
    const form = document.getElementById(formId);
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
    }
  };

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
      currentStepSubmitRef.current();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const heading =
    currentStep === "provider"
      ? t("DashboardCustody.chooseProvider")
      : isByokDetails
        ? t("DashboardCustody.byokProviderDetails")
        : t("DashboardCustody.walletDetails");
  const canContinue = Boolean(selectedProviderEntry);
  const stepIndex = SETUP_STEPS.indexOf(currentStep);

  const formContent = (
    <WalletDetailsFields
      canProvisionWallet={canProvisionWallet}
      connectionOptions={connectionOptions}
      environment={environment}
      errorMessage={errorMessage}
      hasManagedConfig={hasManagedConfig}
      isConnected={isConnected}
      onWalletLabelChange={setWalletLabel}
      providerEntry={selectedProviderEntry}
      showConnectionPicker={showConnectionPicker}
      t={t}
      walletLabel={walletLabel}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-wallet-setup-flow="true">
      <div className="shrink-0 px-4 pt-8 pb-6 md:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <WizardStepProgress
            data-wallet-setup-stepper="true"
            currentStep={stepIndex}
            progressLabel={t("DashboardCustody.stepOf", {
              current: stepIndex + 1,
              total: SETUP_STEPS.length,
            })}
            steps={SETUP_STEPS}
          />
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6"
        data-wallet-setup-scroll-region="true"
      >
        <div className="mx-auto w-full max-w-3xl pb-8">
          <div className="space-y-6">
            <h2 className="text-2xl font-medium tracking-tight text-primary">{heading}</h2>

            {currentStep === "provider" ? (
              <form id={PROVIDER_FORM_ID} onSubmit={handleProviderSubmit}>
                <WalletProviderChoices
                  availability={availability}
                  onSelect={(provider) => {
                    setSelectedProvider(provider);
                    setChosenMode(null);
                    setErrorMessage(null);
                  }}
                  selectedProvider={selectedProvider}
                />
              </form>
            ) : (
              <>
                {showModeChoice ? (
                  <CustodyModeField
                    disabled={byokRecoveryLocked || isPending}
                    mode={chosenMode}
                    onModeChange={(mode) => {
                      setChosenMode(mode);
                      setErrorMessage(null);
                    }}
                    t={t}
                  />
                ) : null}
                {byokSetupProvider === null ? null : (
                  <ByokCredentialForm
                    provider={byokSetupProvider}
                    formId={DETAILS_FORM_ID}
                    onRecoveryLockChange={setByokRecoveryLocked}
                  />
                )}
                {isByokDetails || awaitingModeChoice ? null : (
                  <form id={DETAILS_FORM_ID} onSubmit={handleDetailsSubmit} className="grid gap-4">
                    {formContent}
                  </form>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <footer
        className="shrink-0 border-t border-border-default px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6"
        data-wallet-setup-actions="true"
      >
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
          {byokRecoveryLocked ? (
            <span />
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={goBack}
              disabled={isPending}
              iconLeft={currentStep === "details" ? <ArrowLeft className="size-4" /> : undefined}
            >
              {currentStep === "provider"
                ? t("DashboardCustody.cancel")
                : t("DashboardCustody.back")}
            </Button>
          )}

          {currentStep === "provider" ? (
            <Button
              type="submit"
              form={PROVIDER_FORM_ID}
              disabled={!canContinue}
              iconRight={<ArrowRight className="size-4" />}
            >
              {t("DashboardCustody.next")}
            </Button>
          ) : isByokDetails ? null : (
            <Button
              type="submit"
              form={DETAILS_FORM_ID}
              disabled={!canProvisionWallet || isPending}
            >
              {isPending
                ? t("DashboardCustody.createWalletPending")
                : t("DashboardCustody.createWallet")}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
