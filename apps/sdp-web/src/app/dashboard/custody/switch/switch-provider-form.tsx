"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { useState } from "react";

export type SwitchProvider = "fireblocks" | "privy" | "coinbase_cdp" | "para" | "turnkey" | "local";

interface SwitchProviderFormProps {
  action: (formData: FormData) => void | Promise<void>;
  options: Array<{
    value: SwitchProvider;
    label: string;
    disabled?: boolean;
  }>;
  defaultProvider: SwitchProvider;
  disableSubmit: boolean;
  hasReusableWalletByProvider: Record<SwitchProvider, boolean>;
  needsWalletLabelByProvider: Record<SwitchProvider, boolean>;
  isActiveByProvider: Record<SwitchProvider, boolean>;
}

export function SwitchProviderForm({
  action,
  options,
  defaultProvider,
  disableSubmit,
  hasReusableWalletByProvider,
  needsWalletLabelByProvider,
  isActiveByProvider,
}: SwitchProviderFormProps) {
  const [selectedProvider, setSelectedProvider] = useState<SwitchProvider>(defaultProvider);
  const isFireblocks = selectedProvider === "fireblocks";
  const hasReusableWallet = hasReusableWalletByProvider[selectedProvider] ?? false;
  const needsWalletLabel = needsWalletLabelByProvider[selectedProvider] ?? true;
  const isActiveProvider = isActiveByProvider[selectedProvider] ?? false;

  return (
    <form action={action} className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="provider">Provider</Label>
        <select
          id="provider"
          name="provider"
          className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
          defaultValue={defaultProvider}
          disabled={disableSubmit}
          onChange={(event) => {
            setSelectedProvider(event.target.value as SwitchProvider);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {isFireblocks && !isActiveProvider ? (
        <div className="grid gap-4 rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-[#1c1c1d]">Fireblocks credentials</p>
            <p className="text-xs text-[rgba(28,28,29,0.64)]">
              Required to connect Fireblocks for the first time.
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
              <Input id="apiBaseUrl" name="apiBaseUrl" placeholder="https://api.fireblocks.io" />
            </div>
          </div>
        </div>
      ) : null}

      {needsWalletLabel ? (
        <div className="grid gap-2">
          <Label htmlFor="walletLabel">Default wallet label</Label>
          <Input id="walletLabel" name="walletLabel" placeholder="Default" />
        </div>
      ) : hasReusableWallet ? (
        <p className="text-xs text-[rgba(28,28,29,0.64)]">
          Existing root wallet found for this provider. Switching will reuse it.
        </p>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="confirm">Confirmation</Label>
        <Input
          id="confirm"
          name="confirm"
          placeholder="SWITCH"
          required
          pattern="[sS][wW][iI][tT][cC][hH]"
          title="Type SWITCH to confirm provider change."
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={disableSubmit}>
          {isActiveProvider ? "Set as default" : "Connect provider"}
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
