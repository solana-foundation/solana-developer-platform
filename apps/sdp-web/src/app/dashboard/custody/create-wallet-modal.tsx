"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { createCustodyWallet } from "./actions";

interface CreateWalletModalProps {
  disabled?: boolean;
  disabledReason?: string;
}

export function CreateWalletModal({ disabled = false, disabledReason }: CreateWalletModalProps) {
  const [isOpen, setIsOpen] = useState(false);

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
        New wallet
      </Button>

      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
          <button
            type="button"
            aria-label="Close new wallet modal"
            className="absolute inset-0 bg-black/35"
            onClick={close}
          />

          <div className="relative z-10 w-full max-w-lg rounded-2xl border border-[rgba(28,28,29,0.16)] bg-white p-6 shadow-lg">
            <p className="text-sm font-semibold text-[#1c1c1d]">Create wallet</p>
            <p className="mt-1 text-sm text-[rgba(28,28,29,0.72)]">
              Provision an additional signing wallet for your organization.
            </p>

            <form action={createCustodyWallet} className="mt-4 grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="create-wallet-label">Label</Label>
                <Input id="create-wallet-label" name="label" placeholder="Signing wallet" />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="create-wallet-purpose">Purpose (optional)</Label>
                <select
                  id="create-wallet-purpose"
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
                <p className="text-xs text-[rgba(28,28,29,0.64)]">
                  Purposes are used for future policy and UI grouping.
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm text-[rgba(28,28,29,0.72)]">
                <input type="checkbox" name="setDefault" />
                Make default
              </label>

              <div className="mt-2 flex items-center justify-end gap-2">
                <Button type="button" variant="secondary" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit">Create wallet</Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
