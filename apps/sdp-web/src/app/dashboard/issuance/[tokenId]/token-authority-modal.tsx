"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEscapeKey } from "@/lib/use-escape-key";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { useEffect, useMemo, useState } from "react";
import type { PermissionRow } from "./token-management-workspace.types";
import { SOLANA_ADDRESS_PATTERN } from "./token-management-workspace.utils";
import { TokenSignerSelect } from "./token-signer-select";

const REMOVE_AUTHORITY_VALUE = "__remove_authority__";

interface TokenAuthorityModalProps {
  row: PermissionRow | null;
  currentAuthorityValue: string | null;
  newAuthority: string;
  authorityWallets: PaymentsDashboardWallet[];
  authorityWalletsError: string | null;
  signerWallets: PaymentsDashboardWallet[];
  signerWalletId: string;
  signerUnavailableReason: string | null;
  isPending: boolean;
  onNewAuthorityChange: (value: string) => void;
  onSignerWalletIdChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TokenAuthorityModal({
  row,
  currentAuthorityValue,
  newAuthority,
  authorityWallets,
  authorityWalletsError,
  signerWallets,
  signerWalletId,
  signerUnavailableReason,
  isPending,
  onNewAuthorityChange,
  onSignerWalletIdChange,
  onCancel,
  onConfirm,
}: TokenAuthorityModalProps) {
  useEscapeKey(Boolean(row) && !isPending, onCancel);

  const availableWallets = useMemo(
    () => authorityWallets.filter((wallet) => wallet.publicKey.trim()),
    [authorityWallets]
  );
  const walletModeAvailable = authorityWalletsError === null && availableWallets.length > 0;
  const [mode, setMode] = useState<"wallet" | "custom">(walletModeAvailable ? "wallet" : "custom");
  const [selectedWalletValue, setSelectedWalletValue] = useState("");

  const controlledWalletValues = useMemo(
    () => new Set(availableWallets.map((wallet) => wallet.publicKey)),
    [availableWallets]
  );

  useEffect(() => {
    if (!row) {
      return;
    }

    if (!walletModeAvailable) {
      setMode("custom");
      setSelectedWalletValue("");
      return;
    }

    const normalizedAuthority = newAuthority.trim();
    if (!normalizedAuthority) {
      setMode("wallet");
      setSelectedWalletValue(REMOVE_AUTHORITY_VALUE);
      return;
    }

    if (controlledWalletValues.has(normalizedAuthority)) {
      setMode("wallet");
      setSelectedWalletValue(normalizedAuthority);
      return;
    }

    setMode("custom");
    setSelectedWalletValue("");
  }, [controlledWalletValues, newAuthority, row, walletModeAvailable]);

  if (!row) {
    return null;
  }

  const currentAuthority = currentAuthorityValue ?? "Resolved automatically from token state";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(18,18,19,0.44)] p-4">
      <div className="w-full max-w-lg rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]">
        <h4 className="text-[24px] leading-[1.15] font-medium text-[#1c1c1d]">{row.title}</h4>
        <p className="mt-2 text-[15px] leading-[1.45] text-[rgba(28,28,29,0.72)]">{row.helper}</p>

        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <Label>
            Current authority
            <Input value={currentAuthority} readOnly />
          </Label>

          <TokenSignerSelect
            signerWallets={signerWallets}
            signerWalletId={signerWalletId}
            signerUnavailableReason={signerUnavailableReason}
            onSignerWalletIdChange={onSignerWalletIdChange}
          />

          {walletModeAvailable ? (
            <>
              {mode === "wallet" ? (
                <Label className="grid gap-2">
                  <span>New authority</span>
                  <select
                    className="h-11 w-full rounded-[12px] border border-[rgba(28,28,29,0.12)] bg-white px-4 text-sm text-[#1c1c1d] shadow-none outline-none transition-[box-shadow,border-color] focus:border-[rgba(28,28,29,0.28)] focus:ring-2 focus:ring-[rgba(28,28,29,0.12)]"
                    value={selectedWalletValue}
                    required
                    onChange={(event) => {
                      const nextValue = event.currentTarget.value;
                      setSelectedWalletValue(nextValue);
                      onNewAuthorityChange(nextValue === REMOVE_AUTHORITY_VALUE ? "" : nextValue);
                    }}
                  >
                    <option value="" disabled>
                      Select a controlled wallet
                    </option>
                    <option value={REMOVE_AUTHORITY_VALUE}>Remove authority</option>
                    {availableWallets.map((wallet) => (
                      <option key={wallet.id} value={wallet.publicKey}>
                        {wallet.label ? `${wallet.label} · ${wallet.walletId}` : wallet.walletId}
                      </option>
                    ))}
                  </select>
                </Label>
              ) : (
                <Label className="grid gap-2">
                  <span>Custom authority</span>
                  <Input
                    value={newAuthority}
                    onChange={(event) => onNewAuthorityChange(event.currentTarget.value)}
                    placeholder="Solana address"
                    pattern={SOLANA_ADDRESS_PATTERN}
                    title="Enter a valid Solana address."
                    required
                    autoFocus
                  />
                </Label>
              )}

              <div className="flex items-center justify-between gap-3 text-sm">
                <p className="text-[rgba(28,28,29,0.68)]">
                  Controlled wallets are the recommended authority targets.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto px-0 text-[#1c1c1d]"
                  onClick={() => {
                    if (mode === "wallet") {
                      setMode("custom");
                      return;
                    }

                    setMode("wallet");
                    onNewAuthorityChange(
                      selectedWalletValue === REMOVE_AUTHORITY_VALUE ? "" : selectedWalletValue
                    );
                  }}
                  disabled={isPending}
                >
                  {mode === "wallet" ? "Use custom address" : "Choose controlled wallet"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Label className="grid gap-2">
                <span>New authority</span>
                <Input
                  value={newAuthority}
                  onChange={(event) => onNewAuthorityChange(event.currentTarget.value)}
                  placeholder="Solana address or leave empty to remove"
                  pattern={SOLANA_ADDRESS_PATTERN}
                  title="Enter a valid Solana address or leave this blank to remove the authority."
                  autoFocus
                />
              </Label>

              {authorityWalletsError ? (
                <p className="text-sm text-[#8a1f2a]">{authorityWalletsError}</p>
              ) : (
                <p className="text-sm text-[rgba(28,28,29,0.68)]">
                  No controlled wallets are available yet. Enter an address manually or leave it
                  blank to remove the authority.
                </p>
              )}
            </>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || Boolean(signerUnavailableReason)}>
              Save authority
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
