"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState, useTransition } from "react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type SetupStep = "provider" | "details";

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
  const connectedProviderSet = new Set(connectedProviders);

  return (
    <div className="grid gap-4">
      {providers.map((provider) => {
        const isSelected = selectedProvider === provider.id;
        const isConnected = connectedProviderSet.has(provider.id);

        return (
          <button
            key={provider.id}
            type="button"
            onClick={() => onSelect(provider.id)}
            className={cn(
              "group w-full cursor-pointer rounded-2xl border px-5 py-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(28,28,29,0.18)] focus-visible:ring-offset-2",
              isSelected
                ? "border-gray-1400 bg-border-extra-light"
                : "border-border-light bg-white hover:bg-border-extra-light"
            )}
            aria-pressed={isSelected}
          >
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-border-light text-text-extra-high">
                <WalletProviderMark provider={provider.id} size="sm" />
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="relative inline-block text-[22px] leading-none font-medium text-text-extra-high after:absolute after:left-0 after:-bottom-1 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-200 group-hover:after:scale-x-100 group-focus-visible:after:scale-x-100 motion-reduce:after:transition-none">
                    {provider.label}
                  </span>
                  {isConnected ? (
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-text-medium ring-1 ring-border-extra-light">
                      Active
                    </span>
                  ) : null}
                </span>
                <span className="block text-sm text-text-low">{provider.description}</span>
              </span>
            </div>
          </button>
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
  const router = useRouter();
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  };

  const handleCreateWallet = () => {
    const form = document.getElementById("wallet-details-form");
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    if (!form.reportValidity() || !canProvisionWallet || isPending || !selectedProviderEntry) {
      return;
    }

    const formData = new FormData(form);
    setErrorMessage(null);

    startTransition(async () => {
      const result = await formAction(formData);

      if (result.status === "error") {
        setErrorMessage(result.message);
        return;
      }

      router.refresh();
      router.push("/dashboard/wallets");
    });
  };

  if (enabledProviderEntries.length === 0) {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-[rgba(28,28,29,0.1)] bg-white p-6">
        <p className="text-lg font-medium text-[#1c1c1d]">No wallet providers enabled</p>
        <p className="mt-2 text-sm leading-6 text-[rgba(28,28,29,0.62)]">
          Wallet creation is available after a custody provider is enabled for this organization.
        </p>
        <Button asChild variant="secondary" className="mt-5">
          <Link href="/dashboard/wallets">Back to wallets</Link>
        </Button>
      </div>
    );
  }

  const heading = currentStep === "provider" ? "Choose provider" : "Wallet details";
  const canContinue = Boolean(selectedProviderEntry);

  const formContent = (
    <>
      <input type="hidden" name="provider" value={selectedProviderEntry?.id ?? ""} />
      <div className="space-y-2">
        <Label htmlFor="wallet-label">Wallet label</Label>
        <Input
          id="wallet-label"
          name={isConnected ? "label" : "walletLabel"}
          value={walletLabel}
          onChange={(event) => setWalletLabel(event.currentTarget.value)}
          placeholder="Treasury"
          className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
          required
        />
      </div>
      <div className="space-y-2">
        <Label>Project</Label>
        <div className="flex h-12 items-center rounded-2xl border border-border-light bg-border-extra-light px-4 text-sm font-medium text-text-extra-high">
          Default Project
        </div>
      </div>
      <div className="space-y-2">
        <Label>Environment</Label>
        <div className="flex h-12 items-center rounded-2xl border border-border-light bg-border-extra-light px-4 text-sm font-medium text-text-extra-high">
          Sandbox
        </div>
      </div>
      {!canProvisionWallet ? (
        <div className="rounded-2xl border border-border-light bg-border-extra-light px-4 py-3 text-sm leading-6 text-text-low">
          {selectedProviderEntry
            ? `${selectedProviderEntry.label} uses its existing configured wallet in this flow.`
            : "Choose an enabled provider to continue."}
        </div>
      ) : null}
      {errorMessage ? (
        <div
          role="alert"
          className="rounded-2xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text"
        >
          {errorMessage}
        </div>
      ) : null}
    </>
  );

  if (currentStep === "provider") {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div className="text-center">
            <p className="text-[28px] leading-tight font-medium text-text-extra-high">{heading}</p>
          </div>

          <ProviderStep
            connectedProviders={connectedProviders}
            onSelect={(provider) => {
              setSelectedProvider(provider);
              setErrorMessage(null);
            }}
            providers={enabledProviderEntries}
            selectedProvider={selectedProvider}
          />
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="secondary"
            className="h-14 rounded-full text-base"
            onClick={goBack}
            iconLeft={<ArrowLeft className="h-4 w-4" />}
          >
            Previous
          </Button>
          <Button
            type="button"
            className="h-14 rounded-full text-base"
            onClick={continueFromProvider}
            disabled={!canContinue}
            iconRight={<ArrowRight className="h-4 w-4" />}
          >
            Continue
          </Button>
        </div>
      </div>
    );
  }

  if (currentStep === "details") {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div className="text-center">
            <p className="text-[28px] leading-tight font-medium text-text-extra-high">{heading}</p>
          </div>

          <form id="wallet-details-form" onSubmit={handleSubmit} className="grid gap-4">
            {formContent}
          </form>
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="secondary"
            className="h-14 rounded-full text-base"
            onClick={goBack}
            iconLeft={<ArrowLeft className="h-4 w-4" />}
          >
            Previous
          </Button>
          <Button
            type="button"
            className="h-14 rounded-full text-base"
            disabled={!canProvisionWallet || isPending}
            onClick={handleCreateWallet}
          >
            {isPending ? "Creating..." : "Create wallet"}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
