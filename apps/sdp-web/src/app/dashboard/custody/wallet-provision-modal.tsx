"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createCustodyWalletForModal,
  initializeCustodyForModal,
} from "@/app/dashboard/custody/actions";
import {
  CUSTODY_PROVIDER_CATALOG,
  formatCustodyProviderName,
  type KnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEscapeKey } from "@/lib/use-escape-key";
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
  pending,
  idleLabel,
  pendingLabel,
}: {
  disabled: boolean;
  pending: boolean;
  idleLabel: string;
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
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
    setSubmitError(null);
    setIsSubmitting(false);
  }, [connectedProviders, enabledProviders, isOpen, preferredProvider]);

  useEscapeKey(isOpen, onClose);

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
  const helperText = isConnected
    ? "Create an additional wallet for this active custody provider."
    : "Connect this custody provider and create its first wallet in one step.";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canProvisionWallet || isSubmitting) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const action = isConnected ? createCustodyWalletForModal : initializeCustodyForModal;
    setIsSubmitting(true);
    setSubmitError(null);

    void (async () => {
      const result = await action(formData);

      if (result.status === "error") {
        setSubmitError(result.message);
        setIsSubmitting(false);
        return;
      }

      router.refresh();
      onClose();
      setIsSubmitting(false);
    });
  }

  if (!isOpen) {
    return null;
  }

  if (selectableProviders.length === 0) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
      <button
        type="button"
        aria-label="Close wallet modal"
        className="absolute inset-0 bg-black/35"
        onClick={onClose}
      />

      <div className="relative z-10 w-full max-w-xl overflow-hidden rounded-[24px] border border-[rgba(28,28,29,0.12)] bg-white shadow-[0_24px_80px_rgba(0,0,0,0.14)]">
        <div className="border-b border-[rgba(28,28,29,0.08)] px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-[28px] leading-[1.05] font-medium tracking-[-0.03em] text-[#1c1c1d]">
                New wallet
              </p>
              <p className="text-sm text-[rgba(28,28,29,0.62)]">{helperText}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close wallet modal"
            >
              <span className="text-lg leading-none">×</span>
            </Button>
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
                  setSubmitError(null);
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

          {submitError ? (
            <div className="rounded-[16px] border border-[#c71f37]/15 bg-[#c71f37]/[0.04] px-4 py-3 text-sm text-[#8a1f2a]">
              {submitError}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 border-t border-[rgba(28,28,29,0.08)] pt-4">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <SubmitButton
              disabled={!canProvisionWallet}
              pending={isSubmitting}
              idleLabel="Create wallet"
              pendingLabel="Creating..."
            />
          </div>
        </form>
      </div>
    </div>
  );
}
