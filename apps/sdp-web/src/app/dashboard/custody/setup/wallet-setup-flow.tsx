"use client";

import type { CustodyWalletPurpose } from "@sdp/types";
import Link from "next/link";
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
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { WizardFrame } from "@/components/wizard-frame";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { invalidateQuickStartStatus } from "@/lib/dashboard-quick-start";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";

type SetupStep = "provider" | "details";

const SETUP_STEPS = ["provider", "details"] as const satisfies readonly SetupStep[];
const PROVIDER_FORM_ID = "wallet-provider-form";
const DETAILS_FORM_ID = "wallet-details-form";

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
 * Where a provider goes on the first step. Anything usable is a choice in the list; a general
 * provider this deployment has no credentials for stays in the list, disabled, as not ready; a
 * manual provider the organization has not been given sits under "Not set up yet", with a way to
 * set it up.
 */
function providerPlacement(provider: CustodyProviderAvailability): "choice" | "setup" {
  if (provider.isSelectable) return "choice";
  return provider.entry.availability === "manual" ? "setup" : "choice";
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
      <FieldLabel
        label={t("DashboardCustody.walletSetupConnection")}
        hint={t("DashboardCustody.walletSetupConnectionHint")}
      />
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
  // Connected providers lead, then the ones ready to install, then the ones that are not ready;
  // the catalog's order holds within each.
  const choiceRank = (provider: CustodyProviderAvailability) =>
    provider.status === "active" ? 0 : provider.isSelectable ? 1 : 2;
  const choices = availability
    .filter((provider) => providerPlacement(provider) === "choice")
    .sort((a, b) => choiceRank(a) - choiceRank(b));
  const toSetUp = availability.filter((provider) => providerPlacement(provider) === "setup");

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
              const selectable = provider.isSelectable;
              const selected = selectedProvider === provider.entry.id;
              return (
                <label
                  key={provider.entry.id}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3",
                    index > 0 && "border-t border-border-subtle",
                    selectable ? "cursor-pointer" : "cursor-not-allowed"
                  )}
                  data-wallet-provider={provider.entry.id}
                >
                  <input
                    type="radio"
                    name="provider"
                    value={provider.entry.id}
                    checked={selected}
                    disabled={!selectable}
                    onChange={() => onSelect(provider.entry.id)}
                    className="peer sr-only"
                    aria-describedby={`wallet-provider-${provider.entry.id}-description`}
                  />
                  <span className={cn("inline-flex", !selectable && "opacity-50")}>
                    <WalletProviderMark provider={provider.entry.id} size="row" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-nav leading-4.5",
                        selectable ? "text-primary" : "text-tertiary"
                      )}
                    >
                      {provider.entry.label}
                    </span>
                    <span
                      id={`wallet-provider-${provider.entry.id}-description`}
                      className={cn(
                        "block text-body leading-4.5",
                        selectable ? "text-secondary" : "text-tertiary"
                      )}
                    >
                      {t(provider.entry.descriptionKey)}
                    </span>
                  </span>
                  {selectable ? null : (
                    <span className="shrink-0 text-body text-tertiary">
                      {t("DashboardCustody.walletSetupProviderNotReady")}
                    </span>
                  )}
                  {/* The visible radio: a ring, filled to a thick ink ring when chosen. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 rounded-full border border-border-strong transition-[border-width] motion-reduce:transition-none",
                      "peer-checked:border-[5px] peer-checked:border-primary",
                      "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary",
                      !selectable && "opacity-50"
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

      {toSetUp.length > 0 ? (
        <section className="mt-12" data-wallet-provider-setup-list>
          <h3 className="mb-3 text-subheading font-medium text-primary">
            {t("DashboardCustody.walletSetupNotSetUpTitle")}
          </h3>
          <ul>
            {toSetUp.map((provider, index) => (
              <li
                key={provider.entry.id}
                className={cn(
                  "flex items-center gap-3 px-4 py-3",
                  index > 0 && "border-t border-border-subtle"
                )}
              >
                <WalletProviderMark provider={provider.entry.id} size="row" />
                <span className="min-w-0 flex-1">
                  <span className="block text-nav leading-4.5 text-primary">
                    {provider.entry.label}
                  </span>
                  <span className="block text-body leading-4.5 text-secondary">
                    {t(provider.entry.descriptionKey)}
                  </span>
                </span>
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={`/dashboard/integrations/${provider.entry.id}`}
                    aria-label={t("DashboardCustody.walletSetupSetUpProvider", {
                      provider: provider.entry.label,
                    })}
                  >
                    {t("DashboardCustody.walletSetupSetUp")}
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </form>
  );
}

/** Step 2 for a provider that can take a wallet now: the questions, then what it is created in. */
function DetailsStep({
  connectionOptions,
  errorMessage,
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
  errorMessage: string | null;
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
  const { projects, selectedProjectId, sdpEnvironment } = useDashboardWorkspace();
  const cluster = useSolanaCluster();
  const projectName =
    projects.find((project) => project.id === selectedProjectId)?.name ??
    t("DashboardCustody.projectValue");
  const environment = `${t(
    sdpEnvironment === "production" ? "DashboardCustody.production" : "DashboardCustody.sandbox"
  )} · ${cluster === "mainnet-beta" ? "mainnet" : cluster}`;

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
            placeholder={t("DashboardCustody.walletLabelPlaceholder")}
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
          <WalletConnectionField connections={connectionOptions} t={t} />
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
            <dd className="text-body text-primary">{environment}</dd>
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
 * The footer band. Step 1: Cancel and Continue. Step 2: Back, what confirming does, Cancel and
 * Create. A primary action that cannot run yet is outlined, as the design draws it. The Privy
 * credential form carries its own submit, and a submission in an unknown state locks the way out.
 */
function SetupFooter({
  step,
  providerLabel,
  canCreate,
  isPending,
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
        <Button type="button" variant="outline" onClick={onBack} disabled={isPending}>
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
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isPending}>
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
  const { selectedProjectId } = useDashboardWorkspace();
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
  // Switching provider on step 1 must not carry the previous provider's
  // connections into step 2, so the list is narrowed here rather than trusted
  // as delivered. The picker earns its place only when the provider is already
  // installed and something is actually selectable: a legacy Config-backed
  // provider has no connections and keeps the original form.
  const connectionOptions = useMemo(
    () => connections.filter((connection) => connection.provider === selectedProvider),
    [connections, selectedProvider]
  );
  // The availability status comes from legacy Configs. A BYOK-only project has
  // no legacy Config, so an active connection also shows that the provider is
  // installed. Without it, the wizard asks for the credentials again.
  const isConnected =
    selectedAvailability !== null &&
    (selectedAvailability.status === "active" || connectionOptions.some(isSelectableConnection));
  const canProvisionWallet = selectedProviderEntry
    ? !isConnected || selectedProviderEntry.supportsAdditionalWallets
    : false;
  const formAction = isConnected ? createCustodySetupWalletAction : initializeCustodySetupAction;
  const showConnectionPicker = isConnected && connectionOptions.some(isSelectableConnection);
  // An uninstalled Privy under BYOK goes through provider details (credential
  // submission + connection check) instead of the legacy initialize path,
  // which the API refuses once stored-credential setup is enforced.
  const isByokDetails = privyByokEnabled && selectedProviderEntry?.id === "privy" && !isConnected;
  const canCreate = canProvisionWallet && walletLabel.trim().length > 0 && !isPending;

  const leaveFlow = () => router.push("/dashboard/wallets");

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
          invalidateQuickStartStatus();
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
              setErrorMessage(null);
            }}
            onSubmit={handleProviderSubmit}
            t={t}
          />
        ) : isByokDetails ? (
          <PrivyCredentialForm
            formId={DETAILS_FORM_ID}
            onRecoveryLockChange={setByokRecoveryLocked}
          />
        ) : (
          <DetailsStep
            connectionOptions={connectionOptions}
            errorMessage={errorMessage}
            notice={
              canProvisionWallet
                ? null
                : selectedProviderEntry
                  ? t("DashboardCustody.connectedProviderDescription", {
                      provider: selectedProviderEntry.label,
                    })
                  : t("DashboardCustody.chooseEnabledProvider")
            }
            isConnected={isConnected}
            onChangeProvider={goToProviderStep}
            onSubmit={handleDetailsSubmit}
            onWalletLabelChange={setWalletLabel}
            providerEntry={selectedProviderEntry}
            showConnectionPicker={showConnectionPicker}
            t={t}
            walletLabel={walletLabel}
          />
        )}
      </WizardFrame>
    </div>
  );
}
