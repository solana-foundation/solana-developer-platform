"use client";

import { ArrowLeft, ArrowRight, Shield, WalletMinimal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import {
  createCustodySetupWalletAction,
  initializeCustodySetupAction,
} from "@/app/dashboard/custody/actions";
import {
  type CustodyProviderCatalogEntry,
  getCustodyProviderCategory,
  getCustodyProvidersByCategory,
  type KnownCustodyProvider,
  WALLET_PROVIDER_CATEGORIES,
  WALLET_PROVIDER_CATEGORY_DETAILS,
  type WalletProviderCategory,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type SetupStep = "type" | "provider" | "details";

interface WalletSetupFlowProps {
  connectedProviders: KnownCustodyProvider[];
  enabledProviders: KnownCustodyProvider[];
  initialCategory?: WalletProviderCategory | null;
  initialProvider?: KnownCustodyProvider | null;
}

function getProvidersForCategory(
  category: WalletProviderCategory,
  enabledProviders: KnownCustodyProvider[]
): CustodyProviderCatalogEntry[] {
  const enabledProviderSet = new Set(enabledProviders);
  return getCustodyProvidersByCategory(category).filter((provider) =>
    enabledProviderSet.has(provider.id)
  );
}

function getEnabledProviderEntries(
  enabledProviders: KnownCustodyProvider[]
): CustodyProviderCatalogEntry[] {
  return WALLET_PROVIDER_CATEGORIES.flatMap((category) =>
    getProvidersForCategory(category, enabledProviders)
  );
}

function resolveInitialProviderForCategory(
  category: WalletProviderCategory,
  preferredProvider: KnownCustodyProvider | null | undefined,
  connectedProviders: KnownCustodyProvider[],
  enabledProviders: KnownCustodyProvider[]
): KnownCustodyProvider | null {
  const providers = getProvidersForCategory(category, enabledProviders);
  if (providers.length === 0) {
    return null;
  }

  if (preferredProvider && providers.some((provider) => provider.id === preferredProvider)) {
    return preferredProvider;
  }

  const connectedProviderSet = new Set(connectedProviders);
  const connectedCreateable = providers.find(
    (provider) => connectedProviderSet.has(provider.id) && provider.supportsAdditionalWallets
  );
  const unconnectedProvider = providers.find((provider) => !connectedProviderSet.has(provider.id));

  return connectedCreateable?.id ?? unconnectedProvider?.id ?? providers[0]?.id ?? null;
}

function getInitialSelection(input: {
  connectedProviders: KnownCustodyProvider[];
  enabledProviders: KnownCustodyProvider[];
  initialCategory?: WalletProviderCategory | null;
  initialProvider?: KnownCustodyProvider | null;
}): {
  category: WalletProviderCategory | null;
  provider: KnownCustodyProvider | null;
  step: SetupStep;
} {
  const { connectedProviders, enabledProviders, initialCategory, initialProvider } = input;
  if (initialProvider && enabledProviders.includes(initialProvider)) {
    const category = getCustodyProviderCategory(initialProvider);
    return {
      category,
      provider: initialProvider,
      step: "details",
    };
  }

  if (initialCategory) {
    return {
      category: initialCategory,
      provider: resolveInitialProviderForCategory(
        initialCategory,
        initialProvider,
        connectedProviders,
        enabledProviders
      ),
      step: "provider",
    };
  }

  return {
    category: null,
    provider: null,
    step: "type",
  };
}

function CategoryIcon({
  category,
  className,
}: {
  category: WalletProviderCategory;
  className?: string;
}) {
  const Icon = category === "server" ? WalletMinimal : Shield;
  return <Icon className={cn("h-4 w-4 text-[#1c1c1d]", className)} aria-hidden="true" />;
}

function TypeStep({
  enabledProviders,
  onSelect,
}: {
  enabledProviders: KnownCustodyProvider[];
  onSelect: (category: WalletProviderCategory) => void;
}) {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 py-12">
      {WALLET_PROVIDER_CATEGORIES.map((category) => {
        const details = WALLET_PROVIDER_CATEGORY_DETAILS[category];
        const providers = getProvidersForCategory(category, enabledProviders);
        const isDisabled = providers.length === 0;

        return (
          <button
            key={category}
            type="button"
            onClick={() => onSelect(category)}
            disabled={isDisabled}
            aria-label={`Choose ${details.label} wallet`}
            className={cn(
              "group w-full cursor-pointer rounded-2xl border border-border-light bg-white px-5 py-5 text-left transition-colors hover:bg-border-extra-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(28,28,29,0.18)] focus-visible:ring-offset-2",
              isDisabled ? "cursor-not-allowed opacity-50" : ""
            )}
          >
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-border-light text-text-extra-high">
                <CategoryIcon category={category} className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <span className="relative inline-block text-[22px] leading-none font-medium text-text-extra-high after:absolute after:left-0 after:-bottom-1 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-200 group-hover:after:scale-x-100 group-focus-visible:after:scale-x-100 motion-reduce:after:transition-none">
                  {details.label} wallet
                </span>
                <span className="block text-sm text-text-low">{details.description}</span>
              </span>
              {!isDisabled ? (
                <span
                  className="mt-0.5 flex h-10 w-10 shrink-0 translate-x-2 items-center justify-center rounded-full border border-border-light bg-white text-text-extra-high opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 motion-reduce:translate-x-0 motion-reduce:transition-none"
                  aria-hidden="true"
                >
                  <ArrowRight className="h-5 w-5" />
                </span>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
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
  initialCategory = null,
  initialProvider = null,
}: WalletSetupFlowProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const initialSelection = useMemo(
    () =>
      getInitialSelection({
        connectedProviders,
        enabledProviders,
        initialCategory,
        initialProvider,
      }),
    [connectedProviders, enabledProviders, initialCategory, initialProvider]
  );
  const [currentStep, setCurrentStep] = useState<SetupStep>(initialSelection.step);
  const [selectedCategory, setSelectedCategory] = useState<WalletProviderCategory | null>(
    initialSelection.category
  );
  const [selectedProvider, setSelectedProvider] = useState<KnownCustodyProvider | null>(
    initialSelection.provider
  );
  const [walletLabel, setWalletLabel] = useState("Treasury");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const enabledProviderEntries = useMemo(
    () => getEnabledProviderEntries(enabledProviders),
    [enabledProviders]
  );
  const connectedProviderSet = useMemo(() => new Set(connectedProviders), [connectedProviders]);
  const selectableProviders = useMemo(
    () => (selectedCategory ? getProvidersForCategory(selectedCategory, enabledProviders) : []),
    [enabledProviders, selectedCategory]
  );
  const selectedProviderEntry = useMemo(
    () =>
      selectableProviders.find((provider) => provider.id === selectedProvider) ??
      selectableProviders[0] ??
      null,
    [selectableProviders, selectedProvider]
  );
  const isConnected = selectedProviderEntry
    ? connectedProviderSet.has(selectedProviderEntry.id)
    : false;
  const canProvisionWallet =
    Boolean(selectedProviderEntry) &&
    (!isConnected || selectedProviderEntry.supportsAdditionalWallets);
  const formAction = isConnected ? createCustodySetupWalletAction : initializeCustodySetupAction;

  const chooseCategory = (category: WalletProviderCategory) => {
    setSelectedCategory(category);
    setSelectedProvider(
      resolveInitialProviderForCategory(
        category,
        selectedProvider,
        connectedProviders,
        enabledProviders
      )
    );
    setErrorMessage(null);
  };

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
    if (currentStep === "provider") {
      setCurrentStep("type");
    }
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

  const canContinue = Boolean(selectedProviderEntry);
  const heading = currentStep === "provider" ? "Choose provider" : "Wallet details";

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

  if (currentStep === "type") {
    return (
      <TypeStep
        enabledProviders={enabledProviders}
        onSelect={(category) => {
          chooseCategory(category);
          setCurrentStep("provider");
        }}
      />
    );
  }

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
            providers={selectableProviders}
            selectedProvider={selectedProviderEntry?.id ?? selectedProvider}
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
