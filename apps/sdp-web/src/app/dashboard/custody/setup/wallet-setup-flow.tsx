"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createCustodySetupWalletAction,
  initializeCustodySetupAction,
} from "@/app/dashboard/custody/actions";
import {
  CUSTODY_PROVIDER_CATALOG,
  type CustodyProviderCatalogEntry,
  type KnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProviderSelectionCard } from "@/components/ui/provider-selection-card";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { useTranslations } from "@/i18n/provider";
import { useDashboardRouter } from "@/lib/use-dashboard-router";

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
}

function getEnabledProviderEntries(
  enabledProviders: KnownCustodyProvider[]
): CustodyProviderCatalogEntry[] {
  const enabledProviderSet = new Set(enabledProviders);
  return CUSTODY_PROVIDER_CATALOG.filter((provider) => enabledProviderSet.has(provider.id));
}

function getInitialSelection(input: {
  enabledProviders: KnownCustodyProvider[];
  initialProvider?: KnownCustodyProvider | null;
}): {
  provider: KnownCustodyProvider | null;
  step: SetupStep;
} {
  const { enabledProviders, initialProvider } = input;
  if (initialProvider && enabledProviders.includes(initialProvider)) {
    return {
      provider: initialProvider,
      step: "details",
    };
  }

  return {
    provider: null,
    step: "provider",
  };
}

function ProviderStep({
  connectedProviders,
  onSelect,
  providers,
  selectedProvider,
}: {
  connectedProviders: KnownCustodyProvider[];
  onSelect: (provider: KnownCustodyProvider) => void;
  providers: CustodyProviderCatalogEntry[];
  selectedProvider: KnownCustodyProvider | null;
}) {
  const t = useTranslations();
  const connectedProviderSet = new Set(connectedProviders);

  return (
    <div className="grid gap-4">
      {providers.map((provider) => {
        const isSelected = selectedProvider === provider.id;
        const isConnected = connectedProviderSet.has(provider.id);

        return (
          <ProviderSelectionCard
            key={provider.id}
            onSelect={() => onSelect(provider.id)}
            isSelected={isSelected}
            advanceOnEnter={isSelected}
            icon={<WalletProviderMark provider={provider.id} size="sm" />}
            title={provider.label}
            description={t(provider.descriptionKey)}
            badge={
              isConnected ? (
                <span className="rounded-full bg-surface-raised px-3 py-1 text-xs font-medium text-secondary ring-1 ring-border-subtle">
                  {t("DashboardCustody.active")}
                </span>
              ) : undefined
            }
          />
        );
      })}
    </div>
  );
}

export function WalletSetupFlow({
  connectedProviders,
  enabledProviders,
  initialProvider = null,
}: WalletSetupFlowProps) {
  const t = useTranslations();
  const router = useDashboardRouter();
  const [isPending, startTransition] = useTransition();
  const enabledProviderEntries = useMemo(
    () => getEnabledProviderEntries(enabledProviders),
    [enabledProviders]
  );
  const initialSelection = useMemo(
    () =>
      getInitialSelection({
        enabledProviders,
        initialProvider,
      }),
    [enabledProviders, initialProvider]
  );
  const [currentStep, setCurrentStep] = useState<SetupStep>(initialSelection.step);
  const [selectedProvider, setSelectedProvider] = useState<KnownCustodyProvider | null>(
    initialSelection.provider
  );
  const [walletLabel, setWalletLabel] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submissionInFlightRef = useRef(false);

  const connectedProviderSet = useMemo(() => new Set(connectedProviders), [connectedProviders]);
  const selectedProviderEntry = useMemo(
    () => enabledProviderEntries.find((provider) => provider.id === selectedProvider) ?? null,
    [enabledProviderEntries, selectedProvider]
  );
  const isConnected = selectedProviderEntry
    ? connectedProviderSet.has(selectedProviderEntry.id)
    : false;
  const canProvisionWallet = selectedProviderEntry
    ? !isConnected || selectedProviderEntry.supportsAdditionalWallets
    : false;
  const formAction = isConnected ? createCustodySetupWalletAction : initializeCustodySetupAction;

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

  if (enabledProviderEntries.length === 0) {
    return (
      <div className="h-full overflow-y-auto px-4 py-6 md:px-6">
        <div className="mx-auto max-w-3xl rounded-lg border border-border-default bg-surface-raised p-6">
          <p className="text-lg font-medium text-primary">
            {t("DashboardCustody.noWalletProvidersEnabled")}
          </p>
          <p className="mt-2 text-sm leading-6 text-secondary">
            {t("DashboardCustody.walletCreationAvailable")}
          </p>
          <Button asChild variant="secondary" className="mt-5">
            <Link href="/dashboard/wallets">{t("DashboardCustody.backToWallets")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const heading =
    currentStep === "provider"
      ? t("DashboardCustody.chooseProvider")
      : t("DashboardCustody.walletDetails");
  const canContinue = Boolean(selectedProviderEntry);
  const stepIndex = SETUP_STEPS.indexOf(currentStep);

  const formContent = (
    <>
      <input type="hidden" name="provider" value={selectedProviderEntry?.id ?? ""} />
      <div className="space-y-2">
        <Label htmlFor="wallet-label">{t("DashboardCustody.walletLabel")}</Label>
        <Input
          id="wallet-label"
          name={isConnected ? "label" : "walletLabel"}
          value={walletLabel}
          onChange={(event) => setWalletLabel(event.currentTarget.value)}
          placeholder={t("DashboardCustody.walletLabelPlaceholder")}
          className="h-12 rounded-2xl border-border-default bg-surface-raised px-4 shadow-none"
          required
        />
      </div>
      <div className="space-y-2">
        <Label>{t("DashboardCustody.project")}</Label>
        <div className="flex h-12 items-center rounded-2xl border border-border-default bg-fill-subtle px-4 text-sm font-medium text-primary">
          {t("DashboardCustody.projectValue")}
        </div>
      </div>
      <div className="space-y-2">
        <Label>{t("DashboardCustody.environment")}</Label>
        <div className="flex h-12 items-center rounded-2xl border border-border-default bg-fill-subtle px-4 text-sm font-medium text-primary">
          {t("DashboardCustody.sandbox")}
        </div>
      </div>
      {!canProvisionWallet ? (
        <div className="rounded-2xl border border-border-default bg-fill-subtle px-4 py-3 text-sm leading-6 text-tertiary">
          {selectedProviderEntry
            ? t("DashboardCustody.connectedProviderDescription", {
                provider: selectedProviderEntry.label,
              })
            : t("DashboardCustody.chooseEnabledProvider")}
        </div>
      ) : null}
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

  return (
    <div className="flex h-full min-h-0 flex-col" data-wallet-setup-flow="true">
      <div className="shrink-0 px-4 pt-2 pb-6 md:px-6">
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
                <ProviderStep
                  connectedProviders={connectedProviders}
                  onSelect={(provider) => {
                    setSelectedProvider(provider);
                    setErrorMessage(null);
                  }}
                  providers={enabledProviderEntries}
                  selectedProvider={selectedProvider}
                />
              </form>
            ) : (
              <form id={DETAILS_FORM_ID} onSubmit={handleDetailsSubmit} className="grid gap-4">
                {formContent}
              </form>
            )}
          </div>
        </div>
      </div>

      <footer
        className="shrink-0 border-t border-border-default bg-surface-raised/95 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6"
        data-wallet-setup-actions="true"
      >
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={goBack}
            disabled={isPending}
            iconLeft={currentStep === "details" ? <ArrowLeft className="size-4" /> : undefined}
          >
            {currentStep === "provider" ? t("DashboardCustody.cancel") : t("DashboardCustody.back")}
          </Button>

          {currentStep === "provider" ? (
            <Button
              type="submit"
              form={PROVIDER_FORM_ID}
              disabled={!canContinue}
              iconRight={<ArrowRight className="size-4" />}
            >
              {t("DashboardCustody.next")}
            </Button>
          ) : (
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
