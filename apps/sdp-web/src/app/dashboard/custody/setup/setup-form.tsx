"use client";

import {
  CUSTODY_FEATURES,
  CUSTODY_PROVIDER_CATALOG,
  type KnownCustodyProvider,
  formatCustodyProviderName,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

type SetupProvider = KnownCustodyProvider;

interface CustodySetupFormProps {
  initializeAction: (formData: FormData) => void | Promise<void>;
  createWalletAction: (formData: FormData) => void | Promise<void>;
  connectedProviders: SetupProvider[];
}

export function CustodySetupForm({
  initializeAction,
  createWalletAction,
  connectedProviders,
}: CustodySetupFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectingProvider, setSelectingProvider] = useState<SetupProvider | null>(null);

  const selectedProvider = useMemo(() => {
    const provider = searchParams.get("provider");
    if (!provider || !isKnownCustodyProvider(provider)) {
      return null;
    }
    return provider;
  }, [searchParams]);

  const connectedProviderSet = useMemo(() => new Set(connectedProviders), [connectedProviders]);

  if (!selectedProvider) {
    return (
      <div className="grid gap-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-[#1c1c1d]">Choose a provider</p>
          <p className="text-xs text-[rgba(28,28,29,0.64)]">
            Select a provider to continue. Activated providers are shown in gray with a check.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {CUSTODY_PROVIDER_CATALOG.map((provider) => {
            const isActive = connectedProviderSet.has(provider.id);
            const isSelected = selectingProvider === provider.id;
            const isSelectionPending = selectingProvider !== null;

            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => {
                  if (isSelectionPending) {
                    return;
                  }
                  setSelectingProvider(provider.id);
                  window.setTimeout(() => {
                    router.push(`/dashboard/wallets/setup?provider=${provider.id}`);
                  }, 180);
                }}
                disabled={isSelectionPending}
                className={[
                  "rounded-xl border p-4 text-left transition-all duration-200",
                  isActive
                    ? "border-[rgba(28,28,29,0.16)] bg-[rgba(28,28,29,0.06)]"
                    : "border-[rgba(28,28,29,0.12)] bg-white",
                  isSelected ? "scale-[0.98]" : "",
                  isSelectionPending && !isSelected ? "opacity-60" : "",
                ].join(" ")}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[#1c1c1d]">{provider.label}</p>
                    <p className="mt-1 text-xs text-[rgba(28,28,29,0.64)]">
                      {provider.description}
                    </p>
                  </div>
                  {isActive ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(28,28,29,0.12)] px-2 py-0.5 text-[11px] font-medium text-[#1c1c1d]">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Activated
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {CUSTODY_FEATURES.map((feature) => (
                    <span
                      key={feature}
                      className="rounded-full border border-[rgba(28,28,29,0.16)] bg-[rgba(28,28,29,0.04)] px-2 py-0.5 text-[11px] text-[rgba(28,28,29,0.78)]"
                    >
                      {feature}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const selectedProviderEntry =
    CUSTODY_PROVIDER_CATALOG.find((provider) => provider.id === selectedProvider) ??
    CUSTODY_PROVIDER_CATALOG[0];
  const isConnected = connectedProviderSet.has(selectedProvider);
  const isFireblocks = selectedProvider === "fireblocks";
  const supportsAdditionalWallets = selectedProviderEntry.supportsAdditionalWallets;
  const canCreateAdditionalWallet = !isConnected || supportsAdditionalWallets;
  const formAction = isConnected ? createWalletAction : initializeAction;

  return (
    <form action={formAction} className="grid gap-5">
      <div className="grid gap-2">
        <Label>Provider</Label>
        <input type="hidden" name="provider" value={selectedProvider} />
        <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-[#1c1c1d]">
              {formatCustodyProviderName(selectedProvider)}
            </p>
            {isConnected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(28,28,29,0.12)] px-2 py-0.5 text-[11px] font-medium text-[#1c1c1d]">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Activated
              </span>
            ) : null}
          </div>
          <p className="text-xs text-[rgba(28,28,29,0.64)]">{selectedProviderEntry.description}</p>
        </div>
      </div>

      <div className="grid gap-2">
        <Label>Available features</Label>
        <div className="flex flex-wrap gap-2">
          {CUSTODY_FEATURES.map((feature) => (
            <span
              key={feature}
              className="rounded-full border border-[rgba(28,28,29,0.16)] bg-[rgba(28,28,29,0.04)] px-2 py-0.5 text-xs text-[rgba(28,28,29,0.78)]"
            >
              {feature}
            </span>
          ))}
        </div>
      </div>

      {isConnected ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="label">Wallet label</Label>
            <Input id="label" name="label" placeholder="Signing wallet" />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="purpose">Purpose (optional)</Label>
            <select
              id="purpose"
              name="purpose"
              className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
              defaultValue=""
            >
              <option value="">Not set</option>
              <option value="root">root</option>
              <option value="mint_authority">mint_authority</option>
              <option value="freeze_authority">freeze_authority</option>
              <option value="fee_payer">fee_payer</option>
              <option value="transfer">transfer</option>
            </select>
          </div>

          {!canCreateAdditionalWallet ? (
            <p className="text-xs text-[rgba(28,28,29,0.64)]">
              Additional wallet provisioning is not available yet for this provider.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <div className="grid gap-2">
            <Label htmlFor="walletLabel">Wallet label</Label>
            <Input id="walletLabel" name="walletLabel" placeholder="Primary wallet" />
          </div>

          {isFireblocks ? (
            <div className="grid gap-4 rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-[#1c1c1d]">Fireblocks credentials</p>
                <p className="text-xs text-[rgba(28,28,29,0.64)]">
                  Required when provider is Fireblocks.
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="apiKey">API key</Label>
                <Input id="apiKey" name="apiKey" placeholder="Fireblocks API key" required />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="apiSecretPem">API secret PEM</Label>
                <textarea
                  id="apiSecretPem"
                  name="apiSecretPem"
                  className="min-h-28 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 py-2 text-sm text-[#1c1c1d]"
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="vaultAccountId">Vault account ID</Label>
                <Input
                  id="vaultAccountId"
                  name="vaultAccountId"
                  placeholder="Vault account ID"
                  required
                />
              </div>

              <div className="grid gap-2 md:grid-cols-2 md:gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="assetId">Asset ID (optional)</Label>
                  <Input id="assetId" name="assetId" placeholder="SOL" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="apiBaseUrl">API base URL (optional)</Label>
                  <Input
                    id="apiBaseUrl"
                    name="apiBaseUrl"
                    placeholder="https://api.fireblocks.io"
                  />
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={isConnected && !canCreateAdditionalWallet}>
          {isConnected ? "Create wallet" : "Connect provider & create wallet"}
        </Button>
        <Link href="/dashboard/wallets">
          <Button type="button" variant="secondary">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
