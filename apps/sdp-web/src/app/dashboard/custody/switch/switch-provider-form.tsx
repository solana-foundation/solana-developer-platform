"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { useState } from "react";

export type SwitchProvider = "privy" | "coinbase_cdp" | "anchorage" | "para" | "turnkey" | "local";

interface SwitchProviderFormProps {
  action: (formData: FormData) => void | Promise<void>;
  options: Array<{
    value: SwitchProvider;
    label: string;
    disabled?: boolean;
  }>;
  defaultProvider: SwitchProvider;
  disableSubmit: boolean;
  needsWalletLabelByProvider: Record<SwitchProvider, boolean>;
}

export function SwitchProviderForm({
  action,
  options,
  defaultProvider,
  disableSubmit,
  needsWalletLabelByProvider,
}: SwitchProviderFormProps) {
  const [selectedProvider, setSelectedProvider] = useState<SwitchProvider>(defaultProvider);
  const needsWalletLabel = needsWalletLabelByProvider[selectedProvider] ?? true;

  return (
    <form action={action} className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="provider">New provider</Label>
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

      {needsWalletLabel ? (
        <div className="grid gap-2">
          <Label htmlFor="walletLabel">Default wallet label</Label>
          <Input id="walletLabel" name="walletLabel" placeholder="Default" />
        </div>
      ) : (
        <p className="text-xs text-[rgba(28,28,29,0.64)]">
          Existing root wallet found for this provider. Switching will reuse it.
        </p>
      )}

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
          Switch provider
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
