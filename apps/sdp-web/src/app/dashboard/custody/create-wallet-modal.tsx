"use client";

import { useState } from "react";
import {
  formatCustodyProviderName,
  type KnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { createCustodyWallet } from "./actions";

interface CreateWalletModalProps {
  disabled?: boolean;
  disabledReason?: string;
  providers?: KnownCustodyProvider[];
  triggerLabel?: string;
}

export function CreateWalletModal({
  disabled = false,
  disabledReason,
  providers = [],
  triggerLabel = "New wallet",
}: CreateWalletModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasProviderOptions = providers.length > 0;

  const close = () => {
    setIsOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        onClick={() => setIsOpen(true)}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
      >
        {triggerLabel}
      </Button>

      <Modal
        isOpen={isOpen}
        onClose={close}
        ariaLabel="Create wallet"
        closeLabel="Close new wallet modal"
        contentClassName="p-6"
        size="md"
      >
        <p className="pr-12 text-sm font-semibold text-[#1c1c1d]">Create wallet</p>
        <p className="mt-1 text-sm text-[rgba(28,28,29,0.72)]">
          Provision an additional signing wallet for your organization.
        </p>

        <form action={createCustodyWallet} className="mt-4 grid gap-4">
          {providers.length > 1 ? (
            <div className="grid gap-2">
              <Label htmlFor="create-wallet-provider">Provider</Label>
              <select
                id="create-wallet-provider"
                name="provider"
                className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
                defaultValue={providers[0]}
                required
              >
                {providers.map((provider) => (
                  <option key={provider} value={provider}>
                    {formatCustodyProviderName(provider)}
                  </option>
                ))}
              </select>
            </div>
          ) : providers.length === 1 ? (
            <input type="hidden" name="provider" value={providers[0]} />
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="create-wallet-label">Label</Label>
            <Input id="create-wallet-label" name="label" placeholder="Signing wallet" />
          </div>

          {!hasProviderOptions ? (
            <p className="text-xs text-[rgba(28,28,29,0.64)]">
              Connect a provider that supports additional wallet provisioning first.
            </p>
          ) : null}

          <div className="mt-2 flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!hasProviderOptions}>
              Create wallet
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
