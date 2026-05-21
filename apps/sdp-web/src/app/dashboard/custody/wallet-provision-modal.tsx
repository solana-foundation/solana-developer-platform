"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState, useTransition } from "react";
import {
  createCustodyWalletModalAction,
  initializeCustodyModalAction,
} from "@/app/dashboard/custody/actions";
import {
  type CustodyProviderCatalogEntry,
  formatCustodyProviderName,
  getCustodyProviderCategory,
  getCustodyProviderEntry,
  getCustodyProvidersByCategory,
  type KnownCustodyProvider,
  WALLET_PROVIDER_CATEGORIES,
  WALLET_PROVIDER_CATEGORY_DETAILS,
  type WalletProviderCategory,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletCategoryBadge } from "@/app/dashboard/custody/wallet-category-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { WalletProviderMark } from "./wallet-provider-mark";

type ProvisionStep = "category" | "details";

interface ModalSelection {
  step: ProvisionStep;
  category: WalletProviderCategory | null;
  provider: KnownCustodyProvider | null;
}

function getEnabledProviderEntries(
  enabledProviders: KnownCustodyProvider[]
): CustodyProviderCatalogEntry[] {
  const enabledProviderSet = new Set(enabledProviders);

  return WALLET_PROVIDER_CATEGORIES.flatMap((category) =>
    getCustodyProvidersByCategory(category).filter((provider) =>
      enabledProviderSet.has(provider.id)
    )
  );
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

function resolveInitialProviderForCategory(
  category: WalletProviderCategory,
  preferredProvider: KnownCustodyProvider | null,
  connectedProviders: KnownCustodyProvider[],
  enabledProviders: KnownCustodyProvider[]
): KnownCustodyProvider | null {
  const providers = getProvidersForCategory(category, enabledProviders);
  if (providers.length === 0) {
    return null;
  }

  if (
    preferredProvider &&
    providers.some((provider) => provider.id === preferredProvider) &&
    enabledProviders.includes(preferredProvider)
  ) {
    return preferredProvider;
  }

  const connectedProviderSet = new Set(connectedProviders);
  const connectedCreateable = providers.find(
    (provider) => connectedProviderSet.has(provider.id) && provider.supportsAdditionalWallets
  );
  const unconnectedProvider = providers.find((provider) => !connectedProviderSet.has(provider.id));

  return connectedCreateable?.id ?? unconnectedProvider?.id ?? providers[0]?.id ?? null;
}

function resolveInitialSelection(
  preferredProvider: KnownCustodyProvider | null,
  preferredCategory: WalletProviderCategory | null,
  connectedProviders: KnownCustodyProvider[],
  enabledProviders: KnownCustodyProvider[]
): ModalSelection {
  if (preferredProvider && enabledProviders.includes(preferredProvider)) {
    return {
      step: "details",
      category: getCustodyProviderCategory(preferredProvider),
      provider: preferredProvider,
    };
  }

  if (preferredCategory) {
    const provider = resolveInitialProviderForCategory(
      preferredCategory,
      preferredProvider,
      connectedProviders,
      enabledProviders
    );
    if (provider) {
      return {
        step: "details",
        category: preferredCategory,
        provider,
      };
    }
  }

  return {
    step: "category",
    category: null,
    provider: null,
  };
}

function SubmitButton({
  disabled,
  idleLabel,
  pending,
  pendingLabel,
}: {
  disabled: boolean;
  idleLabel: string;
  pending: boolean;
  pendingLabel: string;
}) {
  return (
    <Button type="submit" disabled={disabled || pending}>
      {pending ? pendingLabel : idleLabel}
    </Button>
  );
}

function CategoryProviderMarks({ providers }: { providers: CustodyProviderCatalogEntry[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((provider) => (
        <WalletProviderMark key={provider.id} provider={provider.id} size="xs" />
      ))}
    </div>
  );
}

function CategoryStepContent({
  enabledProviders,
  onChooseCategory,
  onClose,
  onContinue,
  selectedCategory,
}: {
  enabledProviders: KnownCustodyProvider[];
  onChooseCategory: (category: WalletProviderCategory) => void;
  onClose: () => void;
  onContinue: () => void;
  selectedCategory: WalletProviderCategory | null;
}) {
  return (
    <div className="space-y-6 px-6 py-6">
      <div className="grid gap-4 md:grid-cols-2">
        {WALLET_PROVIDER_CATEGORIES.map((category) => {
          const details = WALLET_PROVIDER_CATEGORY_DETAILS[category];
          const providers = getProvidersForCategory(category, enabledProviders);
          const isSelected = selectedCategory === category;
          const isDisabled = providers.length === 0;

          return (
            <button
              key={category}
              type="button"
              onClick={() => onChooseCategory(category)}
              disabled={isDisabled}
              className={cn(
                "flex min-h-[240px] flex-col rounded-2xl border p-5 text-left transition-colors",
                isSelected
                  ? "border-[#1c1c1d] bg-white"
                  : "border-[rgba(28,28,29,0.12)] bg-[#fcfcfa] hover:border-[rgba(28,28,29,0.22)]",
                isDisabled ? "cursor-not-allowed opacity-50" : ""
              )}
            >
              <WalletCategoryBadge category={category} compact />
              <h3 className="mt-5 text-[22px] leading-[1.1] font-medium text-[#1c1c1d]">
                {details.label}
              </h3>
              <p className="mt-3 text-sm leading-6 text-[rgba(28,28,29,0.62)]">
                {details.description}
              </p>
              <div className="mt-auto pt-5">
                {providers.length > 0 ? (
                  <CategoryProviderMarks providers={providers} />
                ) : (
                  <p className="text-sm text-[rgba(28,28,29,0.58)]">
                    No enabled providers in this category.
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[rgba(28,28,29,0.08)] pt-4">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={onContinue} disabled={!selectedCategory}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function DetailsStepContent({
  canProvisionWallet,
  errorMessage,
  helperText,
  isConnected,
  isPending,
  onBack,
  onClose,
  onProviderChange,
  onSubmit,
  selectableProviders,
  selectedCategoryDetails,
  selectedProviderEntry,
}: {
  canProvisionWallet: boolean;
  errorMessage: string | null;
  helperText: string;
  isConnected: boolean;
  isPending: boolean;
  onBack: () => void;
  onClose: () => void;
  onProviderChange: (provider: KnownCustodyProvider) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  selectableProviders: CustodyProviderCatalogEntry[];
  selectedCategoryDetails: (typeof WALLET_PROVIDER_CATEGORY_DETAILS)[WalletProviderCategory] | null;
  selectedProviderEntry: CustodyProviderCatalogEntry | null;
}) {
  return (
    <form onSubmit={onSubmit} className="grid gap-5 px-6 py-6">
      {selectedCategoryDetails ? (
        <p className="text-sm leading-6 text-[rgba(28,28,29,0.62)]">
          {selectedCategoryDetails.description}
        </p>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="wallet-provider">Provider</Label>
        {selectedProviderEntry ? (
          <input type="hidden" name="provider" value={selectedProviderEntry.id} />
        ) : null}
        <div className="relative">
          <select
            id="wallet-provider"
            value={selectedProviderEntry?.id ?? ""}
            onChange={(event) =>
              onProviderChange(event.currentTarget.value as KnownCustodyProvider)
            }
            className="h-12 w-full appearance-none rounded-[14px] border border-[rgba(28,28,29,0.12)] bg-white pl-11 pr-10 text-sm font-medium text-[#1c1c1d]"
          >
            {selectableProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
          {selectedProviderEntry ? (
            <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
              <WalletProviderMark provider={selectedProviderEntry.id} size="xs" />
            </div>
          ) : null}
        </div>
        <p className="text-xs text-[rgba(28,28,29,0.62)]">
          {selectedProviderEntry
            ? getCustodyProviderEntry(selectedProviderEntry.id).description
            : helperText}
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="wallet-label">Wallet label</Label>
        <Input
          id="wallet-label"
          name={isConnected ? "label" : "walletLabel"}
          placeholder={isConnected ? "Main settlement wallet" : "Primary wallet"}
          required
        />
      </div>

      {!canProvisionWallet ? (
        <div className="rounded-[16px] border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] px-4 py-3 text-sm text-[rgba(28,28,29,0.68)]">
          {selectedProviderEntry
            ? `${formatCustodyProviderName(selectedProviderEntry.id)} is already connected, but additional wallet provisioning is not available for it yet.`
            : helperText}
        </div>
      ) : null}

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-[16px] border border-[#c71f37]/15 bg-[#c71f37]/[0.04] px-4 py-3 text-sm text-[#8a1f2a]"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[rgba(28,28,29,0.08)] pt-4">
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          iconLeft={<ArrowLeft className="h-4 w-4" />}
        >
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <SubmitButton
            disabled={!canProvisionWallet}
            idleLabel="Create wallet"
            pending={isPending}
            pendingLabel="Creating..."
          />
        </div>
      </div>
    </form>
  );
}

interface WalletProvisionModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectedProviders: KnownCustodyProvider[];
  enabledProviders: KnownCustodyProvider[];
  preferredProvider: KnownCustodyProvider | null;
  preferredCategory: WalletProviderCategory | null;
}

export function WalletProvisionModal({
  isOpen,
  onClose,
  connectedProviders,
  enabledProviders,
  preferredProvider,
  preferredCategory,
}: WalletProvisionModalProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [step, setStep] = useState<ProvisionStep>(
    () =>
      resolveInitialSelection(
        preferredProvider,
        preferredCategory,
        connectedProviders,
        enabledProviders
      ).step
  );
  const [selectedCategory, setSelectedCategory] = useState<WalletProviderCategory | null>(
    () =>
      resolveInitialSelection(
        preferredProvider,
        preferredCategory,
        connectedProviders,
        enabledProviders
      ).category
  );
  const [selectedProvider, setSelectedProvider] = useState<KnownCustodyProvider | null>(
    () =>
      resolveInitialSelection(
        preferredProvider,
        preferredCategory,
        connectedProviders,
        enabledProviders
      ).provider
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const selection = resolveInitialSelection(
      preferredProvider,
      preferredCategory,
      connectedProviders,
      enabledProviders
    );
    setStep(selection.step);
    setSelectedCategory(selection.category);
    setSelectedProvider(selection.provider);
    setErrorMessage(null);
  }, [connectedProviders, enabledProviders, isOpen, preferredCategory, preferredProvider]);

  const connectedProviderSet = useMemo(() => new Set(connectedProviders), [connectedProviders]);
  const enabledProviderEntries = useMemo(
    () => getEnabledProviderEntries(enabledProviders),
    [enabledProviders]
  );
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
  const supportsAdditionalWallets = selectedProviderEntry?.supportsAdditionalWallets ?? false;
  const canProvisionWallet =
    Boolean(selectedProviderEntry) && (!isConnected || supportsAdditionalWallets);
  const formAction = isConnected ? createCustodyWalletModalAction : initializeCustodyModalAction;
  const selectedCategoryDetails = selectedCategory
    ? WALLET_PROVIDER_CATEGORY_DETAILS[selectedCategory]
    : null;
  const helperText = selectedProviderEntry
    ? isConnected
      ? "Create an additional wallet for this active provider."
      : "Connect this provider and create its first wallet in one step."
    : "Choose an enabled provider to continue.";

  const chooseCategory = (category: WalletProviderCategory) => {
    const providers = getProvidersForCategory(category, enabledProviders);
    if (providers.length === 0) {
      return;
    }

    setSelectedCategory(category);
    setSelectedProvider(
      resolveInitialProviderForCategory(
        category,
        preferredProvider,
        connectedProviders,
        enabledProviders
      )
    );
    setErrorMessage(null);
  };

  const advanceToDetails = () => {
    if (!selectedCategory) {
      return;
    }

    if (!selectedProvider) {
      setSelectedProvider(
        resolveInitialProviderForCategory(
          selectedCategory,
          preferredProvider,
          connectedProviders,
          enabledProviders
        )
      );
    }
    setStep("details");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!canProvisionWallet || isPending || !selectedProviderEntry) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    setErrorMessage(null);

    startTransition(async () => {
      const result = await formAction(formData);

      if (result.status === "error") {
        setErrorMessage(result.message);
        return;
      }

      router.refresh();
      onClose();
    });
  };
  const handleProviderChange = (provider: KnownCustodyProvider) => {
    setSelectedProvider(provider);
    setErrorMessage(null);
  };
  const handleBack = () => {
    setStep("category");
    setErrorMessage(null);
  };

  if (!isOpen) {
    return null;
  }

  if (enabledProviderEntries.length === 0) {
    return null;
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      closeDisabled={isPending}
      ariaLabel="New wallet"
      closeLabel="Close wallet modal"
      contentClassName="overflow-hidden rounded-[24px] border-[rgba(28,28,29,0.12)] shadow-[0_24px_80px_rgba(0,0,0,0.14)]"
      size="xl"
    >
      <div className="absolute inset-x-0 top-0 h-1 bg-[rgba(28,28,29,0.08)]">
        <div
          className="h-full bg-[#1c1c1d] transition-[width] duration-200"
          style={{ width: step === "category" ? "50%" : "100%" }}
        />
      </div>

      <div className="border-b border-[rgba(28,28,29,0.08)] px-6 py-5">
        <div className="pr-14">
          <div className="space-y-2">
            {step === "details" && selectedCategory ? (
              <WalletCategoryBadge category={selectedCategory} />
            ) : null}
            <p className="text-[28px] leading-[1.05] font-medium tracking-[-0.03em] text-[#1c1c1d]">
              New wallet
            </p>
            <p className="text-sm text-[rgba(28,28,29,0.62)]">
              {step === "category"
                ? "Choose how this wallet will be governed."
                : "Choose provider and give it a label."}
            </p>
          </div>
        </div>
      </div>

      {step === "category" ? (
        <CategoryStepContent
          enabledProviders={enabledProviders}
          onChooseCategory={chooseCategory}
          onClose={onClose}
          onContinue={advanceToDetails}
          selectedCategory={selectedCategory}
        />
      ) : (
        <DetailsStepContent
          canProvisionWallet={canProvisionWallet}
          errorMessage={errorMessage}
          helperText={helperText}
          isConnected={isConnected}
          isPending={isPending}
          onBack={handleBack}
          onClose={onClose}
          onProviderChange={handleProviderChange}
          onSubmit={handleSubmit}
          selectableProviders={selectableProviders}
          selectedCategoryDetails={selectedCategoryDetails}
          selectedProviderEntry={selectedProviderEntry}
        />
      )}
    </Modal>
  );
}
