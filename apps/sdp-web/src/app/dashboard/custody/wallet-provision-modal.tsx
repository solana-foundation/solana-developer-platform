"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState, useTransition } from "react";
import {
  createCustodyWalletModalAction,
  initializeCustodyModalAction,
} from "@/app/dashboard/custody/actions";
import {
  CUSTODY_PROVIDER_CATALOG,
  formatCustodyProviderName,
  type KnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { WalletProviderMark } from "./wallet-provider-mark";

function resolveInitialProvider(
  preferredProvider: KnownCustodyProvider | null,
  connectedProviders: KnownCustodyProvider[],
  enabledProviders: KnownCustodyProvider[]
): KnownCustodyProvider {
  if (preferredProvider && enabledProviders.includes(preferredProvider)) {
    return preferredProvider;
  }

  const connectedProviderSet = new Set(connectedProviders);
  const connectedCreateable = CUSTODY_PROVIDER_CATALOG.find(
    (provider) =>
      enabledProviders.includes(provider.id) &&
      connectedProviderSet.has(provider.id) &&
      provider.supportsAdditionalWallets
  );

  if (connectedCreateable) {
    return connectedCreateable.id;
  }

  return (
    CUSTODY_PROVIDER_CATALOG.find((provider) => enabledProviders.includes(provider.id))?.id ??
    "privy"
  );
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

interface WalletProvisionModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectedProviders: KnownCustodyProvider[];
  enabledProviders: KnownCustodyProvider[];
  preferredProvider: KnownCustodyProvider | null;
}

export function WalletProvisionModal({
  isOpen,
  onClose,
  connectedProviders,
  enabledProviders,
  preferredProvider,
}: WalletProvisionModalProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<KnownCustodyProvider>(
    resolveInitialProvider(preferredProvider, connectedProviders, enabledProviders)
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setSelectedProvider(
      resolveInitialProvider(preferredProvider, connectedProviders, enabledProviders)
    );
    setErrorMessage(null);
  }, [connectedProviders, enabledProviders, isOpen, preferredProvider]);

  const connectedProviderSet = useMemo(() => new Set(connectedProviders), [connectedProviders]);
  const selectableProviders = useMemo(
    () => CUSTODY_PROVIDER_CATALOG.filter((provider) => enabledProviders.includes(provider.id)),
    [enabledProviders]
  );
  const selectedProviderEntry = useMemo(
    () =>
      selectableProviders.find((provider) => provider.id === selectedProvider) ??
      selectableProviders[0],
    [selectableProviders, selectedProvider]
  );
  const isConnected = connectedProviderSet.has(selectedProvider);
  const supportsAdditionalWallets = selectedProviderEntry?.supportsAdditionalWallets ?? false;
  const canProvisionWallet = !isConnected || supportsAdditionalWallets;
  const formAction = isConnected ? createCustodyWalletModalAction : initializeCustodyModalAction;
  const helperText = isConnected
    ? "Create an additional wallet for this active custody provider."
    : "Connect this custody provider and create its first wallet in one step.";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!canProvisionWallet || isPending) {
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

  if (!isOpen) {
    return null;
  }

  if (selectableProviders.length === 0) {
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
      size="lg"
    >
      <div className="border-b border-[rgba(28,28,29,0.08)] px-6 py-5">
        <div className="pr-14">
          <div className="space-y-1">
            <p className="text-[28px] leading-[1.05] font-medium tracking-[-0.03em] text-[#1c1c1d]">
              New wallet
            </p>
            <p className="text-sm text-[rgba(28,28,29,0.62)]">{helperText}</p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="grid gap-5 px-6 py-6">
        <div className="grid gap-2">
          <Label htmlFor="wallet-provider">Provider</Label>
          <input type="hidden" name="provider" value={selectedProvider} />
          <div className="relative">
            <select
              id="wallet-provider"
              value={selectedProvider}
              onChange={(event) => {
                setSelectedProvider(event.currentTarget.value as KnownCustodyProvider);
                setErrorMessage(null);
              }}
              className="h-12 w-full appearance-none rounded-[14px] border border-[rgba(28,28,29,0.12)] bg-white pl-11 pr-10 text-sm font-medium text-[#1c1c1d]"
            >
              {selectableProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
              <WalletProviderMark provider={selectedProvider} size="xs" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {(selectedProviderEntry?.capabilities ?? []).map((feature) => (
              <span
                key={feature}
                className="rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-2.5 py-1 text-[11px] font-medium text-[rgba(28,28,29,0.68)]"
              >
                {feature}
              </span>
            ))}
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="wallet-label">
            {isConnected ? "Wallet label" : "Primary wallet label"}
          </Label>
          <Input
            id="wallet-label"
            name={isConnected ? "label" : "walletLabel"}
            placeholder={isConnected ? "Main settlement wallet" : "Primary wallet"}
            required
          />
        </div>

        {!canProvisionWallet ? (
          <div className="rounded-[16px] border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] px-4 py-3 text-sm text-[rgba(28,28,29,0.68)]">
            {formatCustodyProviderName(selectedProvider)} is already connected, but additional
            wallet provisioning is not available for it yet.
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

        <div className="flex items-center justify-end gap-2 border-t border-[rgba(28,28,29,0.08)] pt-4">
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
      </form>
    </Modal>
  );
}
