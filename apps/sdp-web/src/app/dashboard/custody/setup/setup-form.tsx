"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { useState } from "react";

type SetupProvider = "fireblocks" | "privy" | "coinbase_cdp" | "para" | "turnkey" | "local";

interface CustodySetupFormProps {
  action: (formData: FormData) => void | Promise<void>;
}

export function CustodySetupForm({ action }: CustodySetupFormProps) {
  const [selectedProvider, setSelectedProvider] = useState<SetupProvider>("privy");
  const isFireblocks = selectedProvider === "fireblocks";

  return (
    <form action={action} className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="provider">Provider</Label>
        <select
          id="provider"
          name="provider"
          className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
          defaultValue="privy"
          onChange={(event) => {
            setSelectedProvider(event.target.value as SetupProvider);
          }}
        >
          <option value="privy">Privy (recommended)</option>
          <option value="fireblocks">Fireblocks</option>
          <option value="coinbase_cdp">Coinbase CDP</option>
          <option value="para">Para</option>
          <option value="turnkey">Turnkey</option>
          <option value="local">Local (development only)</option>
        </select>
        <p className="text-xs text-[rgba(28,28,29,0.64)]">
          Fireblocks, Privy, Coinbase CDP, Para, and Turnkey are supported custody providers. Local
          provider mode generates a key stored in the database and should not be used in production.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="walletLabel">Wallet label</Label>
        <Input id="walletLabel" name="walletLabel" placeholder="Master wallet" />
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
              <Input id="apiBaseUrl" name="apiBaseUrl" placeholder="https://api.fireblocks.io" />
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit">Provision wallet</Button>
        <Link href="/dashboard/wallets">
          <Button type="button" variant="secondary">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
