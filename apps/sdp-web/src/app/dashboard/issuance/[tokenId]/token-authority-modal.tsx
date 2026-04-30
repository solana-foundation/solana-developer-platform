"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import type { PermissionRow } from "./token-management-workspace.types";
import {
  getSignerWalletOptionLabel,
  SOLANA_ADDRESS_PATTERN,
} from "./token-management-workspace.utils";
import { TokenWalletIdentityCard } from "./token-wallet-identity-card";

const NONE_AUTHORITY_VALUE = "__none_authority__";

interface TokenAuthorityModalProps {
  row: PermissionRow | null;
  currentAuthorityValue: string | null;
  newAuthority: string;
  authorityWallets: PaymentsDashboardWallet[];
  authorityWalletsError: string | null;
  signerUnavailableReason: string | null;
  isPending: boolean;
  onNewAuthorityChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TokenAuthorityModal({
  row,
  currentAuthorityValue,
  newAuthority,
  authorityWallets,
  authorityWalletsError,
  signerUnavailableReason,
  isPending,
  onNewAuthorityChange,
  onCancel,
  onConfirm,
}: TokenAuthorityModalProps) {
  const dismissModal = () => {
    setNoneConfirmationRowId(null);
    onCancel();
  };

  const availableWallets = useMemo(
    () => authorityWallets.filter((wallet) => wallet.publicKey.trim()),
    [authorityWallets]
  );
  const { walletModeAvailable, mode, setMode, selectedWalletValue, setSelectedWalletValue } =
    useAuthoritySelectionState({
      authorityWalletsError,
      availableWallets,
      newAuthority,
      row,
    });
  const [noneConfirmationRowId, setNoneConfirmationRowId] = useState<string | null>(null);

  if (!row) {
    return null;
  }

  const currentAuthority = currentAuthorityValue ?? "Resolved automatically from token state";
  const isSettingNone = newAuthority.trim().length === 0;
  const isConfirmingNone = noneConfirmationRowId === row.id && isSettingNone;
  const noneConfirmationCopy = getNoneConfirmationCopy(row);
  const currentAuthorityWallet =
    availableWallets.find((wallet) => wallet.publicKey === currentAuthorityValue) ?? null;
  const selectedAuthorityWallet =
    availableWallets.find((wallet) => wallet.publicKey === newAuthority.trim()) ?? null;

  return (
    <Modal
      isOpen={Boolean(row)}
      onClose={dismissModal}
      closeDisabled={isPending}
      ariaLabel={isConfirmingNone ? noneConfirmationCopy.title : row.title}
      closeLabel="Close authority modal"
      contentClassName="border-[rgba(28,28,29,0.12)] p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]"
      size="md"
    >
      {isConfirmingNone ? (
        <NoneConfirmationPanel
          currentAuthority={currentAuthority}
          currentAuthorityValue={currentAuthorityValue}
          currentAuthorityWallet={currentAuthorityWallet}
          copy={noneConfirmationCopy}
          isPending={isPending}
          signerUnavailableReason={signerUnavailableReason}
          onBack={() => setNoneConfirmationRowId(null)}
          onConfirm={() => {
            setNoneConfirmationRowId(null);
            onConfirm();
          }}
        />
      ) : (
        <>
          <h4 className="pr-10 text-[24px] leading-[1.15] font-medium text-[#1c1c1d]">
            {row.title}
          </h4>
          <p className="mt-2 text-[15px] leading-[1.45] text-[rgba(28,28,29,0.72)]">{row.helper}</p>

          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (isSettingNone) {
                setNoneConfirmationRowId(row.id);
                return;
              }
              onConfirm();
            }}
          >
            <CurrentAuthoritySection
              currentAuthority={currentAuthority}
              currentAuthorityValue={currentAuthorityValue}
              currentAuthorityWallet={currentAuthorityWallet}
            />

            <AuthorityTargetSection
              authorityWalletsError={authorityWalletsError}
              availableWallets={availableWallets}
              isPending={isPending}
              isSettingNone={isSettingNone}
              mode={mode}
              newAuthority={newAuthority}
              onNewAuthorityChange={onNewAuthorityChange}
              onToggleMode={() => {
                if (mode === "wallet") {
                  setMode("custom");
                  return;
                }

                setMode("wallet");
                onNewAuthorityChange(
                  selectedWalletValue === NONE_AUTHORITY_VALUE ? "" : selectedWalletValue
                );
              }}
              selectedAuthorityWallet={selectedAuthorityWallet}
              selectedWalletValue={selectedWalletValue}
              setSelectedWalletValue={setSelectedWalletValue}
              walletModeAvailable={walletModeAvailable}
            />

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={dismissModal} disabled={isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending || Boolean(signerUnavailableReason)}>
                Save authority
              </Button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}

function useAuthoritySelectionState({
  authorityWalletsError,
  availableWallets,
  newAuthority,
  row,
}: {
  authorityWalletsError: string | null;
  availableWallets: PaymentsDashboardWallet[];
  newAuthority: string;
  row: PermissionRow | null;
}) {
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
      setSelectedWalletValue(NONE_AUTHORITY_VALUE);
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

  return {
    walletModeAvailable,
    mode,
    setMode,
    selectedWalletValue,
    setSelectedWalletValue,
  };
}

function CurrentAuthoritySection({
  currentAuthority,
  currentAuthorityValue,
  currentAuthorityWallet,
}: {
  currentAuthority: string;
  currentAuthorityValue: string | null;
  currentAuthorityWallet: PaymentsDashboardWallet | null;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]">
        Current authority
      </span>
      <TokenWalletIdentityCard
        wallet={currentAuthorityWallet}
        publicKey={currentAuthorityWallet ? null : currentAuthorityValue}
        emptyLabel={currentAuthority}
      />
    </div>
  );
}

function NoneConfirmationPanel({
  currentAuthority,
  currentAuthorityValue,
  currentAuthorityWallet,
  copy,
  isPending,
  signerUnavailableReason,
  onBack,
  onConfirm,
}: {
  currentAuthority: string;
  currentAuthorityValue: string | null;
  currentAuthorityWallet: PaymentsDashboardWallet | null;
  copy: { title: string; description: string; impact: string };
  isPending: boolean;
  signerUnavailableReason: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h4 className="pr-10 text-[24px] leading-[1.15] font-medium text-[#1c1c1d]">
          {copy.title}
        </h4>
        <p className="mt-2 text-[15px] leading-[1.45] text-[rgba(28,28,29,0.72)]">
          {copy.description}
        </p>
      </div>

      <div className="rounded-xl border border-[rgba(199,31,55,0.18)] bg-[rgba(199,31,55,0.04)] px-4 py-3">
        <p className="text-sm font-medium text-[#8a1f2a]">What this means</p>
        <p className="mt-1 text-sm leading-[1.5] text-[#8a1f2a]">{copy.impact}</p>
      </div>

      <CurrentAuthoritySection
        currentAuthority={currentAuthority}
        currentAuthorityValue={currentAuthorityValue}
        currentAuthorityWallet={currentAuthorityWallet}
      />

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={isPending}>
          Back
        </Button>
        <Button
          type="button"
          onClick={onConfirm}
          disabled={isPending || Boolean(signerUnavailableReason)}
        >
          Yes, set to None
        </Button>
      </div>
    </div>
  );
}

function AuthorityTargetSection({
  authorityWalletsError,
  availableWallets,
  isPending,
  isSettingNone,
  mode,
  newAuthority,
  onNewAuthorityChange,
  onToggleMode,
  selectedAuthorityWallet,
  selectedWalletValue,
  setSelectedWalletValue,
  walletModeAvailable,
}: {
  authorityWalletsError: string | null;
  availableWallets: PaymentsDashboardWallet[];
  isPending: boolean;
  isSettingNone: boolean;
  mode: "wallet" | "custom";
  newAuthority: string;
  onNewAuthorityChange: (value: string) => void;
  onToggleMode: () => void;
  selectedAuthorityWallet: PaymentsDashboardWallet | null;
  selectedWalletValue: string;
  setSelectedWalletValue: (value: string) => void;
  walletModeAvailable: boolean;
}) {
  if (walletModeAvailable) {
    return (
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
                onNewAuthorityChange(nextValue === NONE_AUTHORITY_VALUE ? "" : nextValue);
              }}
            >
              <option value="" disabled>
                Select a controlled wallet
              </option>
              <option value={NONE_AUTHORITY_VALUE}>None</option>
              {availableWallets.map((wallet) => (
                <option key={wallet.id} value={wallet.publicKey}>
                  {getSignerWalletOptionLabel(wallet)}
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

        {isSettingNone ? (
          <p className="text-sm text-[rgba(28,28,29,0.68)]">
            Choosing None will clear this authority. You will confirm that change before it is
            submitted.
          </p>
        ) : null}

        <TokenWalletIdentityCard
          wallet={selectedAuthorityWallet}
          emptyLabel="None"
          emptyDescription="This authority will be cleared if you save this change."
        />

        <div className="flex items-center justify-between gap-3 text-sm">
          <p className="text-[rgba(28,28,29,0.68)]">
            Controlled wallets are the recommended authority targets.
          </p>
          <Button
            type="button"
            variant="ghost"
            className="h-auto px-0 text-[#1c1c1d]"
            onClick={onToggleMode}
            disabled={isPending}
          >
            {mode === "wallet" ? "Use custom address" : "Choose controlled wallet"}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <Label className="grid gap-2">
        <span>New authority</span>
        <Input
          value={newAuthority}
          onChange={(event) => onNewAuthorityChange(event.currentTarget.value)}
          placeholder="Solana address or leave empty to set to None"
          pattern={SOLANA_ADDRESS_PATTERN}
          title="Enter a valid Solana address or leave this blank to set the authority to None."
          autoFocus
        />
      </Label>

      {authorityWalletsError ? (
        <p className="text-sm text-[#8a1f2a]">{authorityWalletsError}</p>
      ) : (
        <p className="text-sm text-[rgba(28,28,29,0.68)]">
          No controlled wallets are available yet. Enter an address manually or leave it blank to
          set the authority to None.
        </p>
      )}

      {isSettingNone ? (
        <p className="text-sm text-[rgba(28,28,29,0.68)]">
          Setting this field to None will clear the authority. You will confirm that change before
          it is submitted.
        </p>
      ) : null}

      <TokenWalletIdentityCard
        wallet={selectedAuthorityWallet}
        publicKey={selectedAuthorityWallet ? null : newAuthority.trim() || null}
        emptyLabel="None"
        emptyDescription="This authority will be cleared if you save this change."
      />
    </>
  );
}

function getNoneConfirmationCopy(row: PermissionRow): {
  title: string;
  description: string;
  impact: string;
} {
  switch (row.authorityRole) {
    case "mint":
      return {
        title: "Set Mint Authority to None?",
        description: "This will clear the mint authority for the token.",
        impact: "No wallet will be able to mint additional supply after this change.",
      };
    case "freeze":
      return {
        title: "Set Freeze Authority to None?",
        description: "This will clear the freeze authority for the token.",
        impact: "Token accounts can no longer be frozen or unfrozen after this change.",
      };
    case "permanentDelegate":
      return {
        title: "Set Permanent Delegate Authority to None?",
        description: "This will clear the permanent delegate authority for the token.",
        impact:
          "Administrative delegated transfer and burn actions will no longer be available after this change.",
      };
    case "metadata":
      return {
        title: "Set Metadata Authority to None?",
        description: "This will clear the metadata authority for the token.",
        impact:
          "Metadata updates will no longer be available through this authority after this change.",
      };
  }
}
