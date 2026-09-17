"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createCustodySetupWalletAction,
  initializeCustodySetupAction,
} from "@/app/dashboard/custody/actions";
import type { CustodyConnectionListItem } from "@/app/dashboard/custody/connections/connections.data";
import type { KnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import {
  type CustodyProviderAvailability,
  resolveCustodyProviderAvailability,
} from "@/app/dashboard/custody/provider-display-status";
import { PrivyCredentialForm } from "@/app/dashboard/custody/setup/privy-credential-form";
import { useWalletInventoryRefresh } from "@/app/dashboard/custody/use-wallet-inventory-refresh";
import { WalletProviderChoices } from "@/app/dashboard/custody/wallet-provider-choices";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { completeQuickStartStep, quickStartKey } from "@/lib/dashboard-quick-start";

type SetupStep = "provider" | "details";

const SETUP_STEPS = ["provider", "details"] as const satisfies readonly SetupStep[];
const PROVIDER_FORM_ID = "wallet-provider-form";
const DETAILS_FORM_ID = "wallet-details-form";

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
  enabledProviders: KnownCustodyProvider[];
  initialProvider?: KnownCustodyProvider | null;
  /** Stored-credential install for Privy; ships dark until the flag is on. */
  privyByokEnabled?: boolean;
  /**
   * Connections the wallet can be created in. Empty whenever the project has
   * none, the provider predates Connections, or the reader lacks
   * `custody:admin` — in every one of those the wizard keeps its old shape.
   */
  connections?: CustodyConnectionListItem[];
}

/**
 * One frozen empty list for the absent-connections case.
 *
 * A `connections = []` default literal is a different array on every render, so
 * it would invalidate the memo that narrows the list by provider every time the
 * wizard re-rendered — on each keystroke in the wallet name — for a value that
 * never changes.
 */
const NO_CONNECTIONS: CustodyConnectionListItem[] = [];

/** Only an active connection holds verified credentials, so only it can take a wallet. */
function isSelectableConnection(connection: CustodyConnectionListItem): boolean {
  return connection.status === "active";
}

/**
 * The connection a wallet lands in unless the user says otherwise: the project
 * default when it is usable, else the first active one. Picking nothing when a
 * usable connection exists would make the wizard fail on submit for no reason.
 */
function defaultConnectionId(connections: CustodyConnectionListItem[]): string {
  const selectable = connections.filter(isSelectableConnection);
  return selectable.find((connection) => connection.isDefault)?.id ?? selectable[0]?.id ?? "";
}

/**
 * Picks the connection a new wallet is created in.
 *
 * Unusable connections stay on the list, disabled and annotated, rather than
 * being filtered out: a user who came here to add a wallet to the connection
 * they just set up needs to see that it is there but not ready yet, not to
 * find it missing.
 */
function WalletConnectionField({
  connections,
  t,
}: {
  connections: CustodyConnectionListItem[];
  t: ReturnType<typeof useTranslations>;
}) {
  const annotate = (connection: CustodyConnectionListItem): string | null => {
    if (isSelectableConnection(connection)) {
      return connection.isDefault ? t("DashboardCustody.walletSetupConnectionDefault") : null;
    }
    return connection.status === "failed"
      ? t("DashboardCustody.walletSetupConnectionUnavailableFailed")
      : t("DashboardCustody.walletSetupConnectionUnavailablePending");
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="wallet-connection">{t("DashboardCustody.walletSetupConnection")}</Label>
      <Select
        name="connectionId"
        ariaLabel={t("DashboardCustody.walletSetupConnection")}
        defaultValue={defaultConnectionId(connections)}
        size="xl"
      >
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

/** Step 2 of the wizard for a provider that is already installed. */
function WalletDetailsFields({
  canProvisionWallet,
  connectionOptions,
  errorMessage,
  isConnected,
  onWalletLabelChange,
  providerEntry,
  showConnectionPicker,
  t,
  walletLabel,
}: {
  canProvisionWallet: boolean;
  connectionOptions: CustodyConnectionListItem[];
  errorMessage: string | null;
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
        <WalletConnectionField connections={connectionOptions} t={t} />
      ) : null}
      <WalletFixedField
        label={t("DashboardCustody.project")}
        value={t("DashboardCustody.projectValue")}
      />
      <WalletFixedField
        label={t("DashboardCustody.environment")}
        value={t("DashboardCustody.sandbox")}
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
  initialProvider?: KnownCustodyProvider | null;
}): {
  provider: KnownCustodyProvider | null;
  step: SetupStep;
} {
  const { availability, initialProvider } = input;
  const requested = initialProvider
    ? availability.find((provider) => provider.entry.id === initialProvider)
    : undefined;

  if (requested?.isSelectable) {
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
  enabledProviders,
  initialProvider = null,
  privyByokEnabled = false,
  connections = NO_CONNECTIONS,
}: WalletSetupFlowProps) {
  const t = useTranslations();
  const router = useRouter();
  const refreshWalletInventory = useWalletInventoryRefresh();
  const { dashboardCacheScope, selectedProjectId } = useDashboardWorkspace();
  const [isPending, startTransition] = useTransition();
  const availability = useMemo(
    () => resolveCustodyProviderAvailability({ connectedProviders, enabledProviders }),
    [connectedProviders, enabledProviders]
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
  // While a BYOK submission is in an unknown state, leaving the step would
  // unmount the frozen payload and key that are the only path to recovery.
  const [byokRecoveryLocked, setByokRecoveryLocked] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submissionInFlightRef = useRef(false);

  const selectedAvailability = useMemo(
    () =>
      availability.find(
        (provider) => provider.isSelectable && provider.entry.id === selectedProvider
      ) ?? null,
    [availability, selectedProvider]
  );
  const selectedProviderEntry = selectedAvailability?.entry ?? null;
  const isConnected = selectedAvailability?.status === "active";
  const canProvisionWallet = selectedProviderEntry
    ? !isConnected || selectedProviderEntry.supportsAdditionalWallets
    : false;
  const formAction = isConnected ? createCustodySetupWalletAction : initializeCustodySetupAction;
  // Switching provider on step 1 must not carry the previous provider's
  // connections into step 2, so the list is narrowed here rather than trusted
  // as delivered. The picker earns its place only when the provider is already
  // installed and something is actually selectable: a legacy Config-backed
  // provider has no connections and keeps the original two-field form.
  const connectionOptions = useMemo(
    () => connections.filter((connection) => connection.provider === selectedProvider),
    [connections, selectedProvider]
  );
  const showConnectionPicker = isConnected && connectionOptions.some(isSelectableConnection);
  // An uninstalled Privy under BYOK goes through provider details (credential
  // submission + connection check) instead of the legacy initialize path,
  // which the API refuses once stored-credential setup is enforced.
  const isByokDetails = privyByokEnabled && selectedProviderEntry?.id === "privy" && !isConnected;

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
    router.push("/dashboard/wallets");
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

    submissionInFlightRef.current = true;
    const formData = new FormData(form);
    setErrorMessage(null);

    startTransition(async () => {
      try {
        const result = await formAction(formData);

        if (result.status === "error") {
          setErrorMessage(result.message);
          return;
        }

        if (selectedProjectId) {
          completeQuickStartStep(quickStartKey(dashboardCacheScope), "wallet");
        }
        refreshWalletInventory();
        router.refresh();
        router.push("/dashboard/wallets");
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
      errorMessage={errorMessage}
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
                    setErrorMessage(null);
                  }}
                  selectedProvider={selectedProvider}
                />
              </form>
            ) : isByokDetails ? (
              <PrivyCredentialForm
                formId={DETAILS_FORM_ID}
                onRecoveryLockChange={setByokRecoveryLocked}
              />
            ) : (
              <form id={DETAILS_FORM_ID} onSubmit={handleDetailsSubmit} className="grid gap-4">
                {formContent}
              </form>
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
