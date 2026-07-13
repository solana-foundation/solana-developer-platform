"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
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
  const t = useTranslations();
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

  const currentAuthority =
    currentAuthorityValue ?? t("DashboardIssuance.authority.resolvedAutomatically");
  const isSettingNone = newAuthority.trim().length === 0;
  const isConfirmingNone = noneConfirmationRowId === row.id && isSettingNone;
  const noneConfirmationCopy = getNoneConfirmationCopy(row, t);
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
      closeLabel={t("DashboardIssuance.authority.closeModal")}
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
                {t("DashboardIssuance.workspace.cancel")}
              </Button>
              <Button type="submit" disabled={isPending || Boolean(signerUnavailableReason)}>
                {t("DashboardIssuance.authority.save")}
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
  const t = useTranslations();
  return (
    <div className="grid gap-2">
      <span className="text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]">
        {t("DashboardIssuance.authority.current")}
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
  const t = useTranslations();
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
        <p className="text-sm font-medium text-[#8a1f2a]">
          {t("DashboardIssuance.authority.whatThisMeans")}
        </p>
        <p className="mt-1 text-sm leading-[1.5] text-[#8a1f2a]">{copy.impact}</p>
      </div>

      <CurrentAuthoritySection
        currentAuthority={currentAuthority}
        currentAuthorityValue={currentAuthorityValue}
        currentAuthorityWallet={currentAuthorityWallet}
      />

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={isPending}>
          {t("DashboardIssuance.create.back")}
        </Button>
        <Button
          type="button"
          onClick={onConfirm}
          disabled={isPending || Boolean(signerUnavailableReason)}
        >
          {t("DashboardIssuance.authority.confirmNone")}
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
  const t = useTranslations();
  if (walletModeAvailable) {
    return (
      <>
        {mode === "wallet" ? (
          <Label className="grid gap-2">
            <span>{t("DashboardIssuance.authority.new")}</span>
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
                {t("DashboardIssuance.authority.selectWallet")}
              </option>
              <option value={NONE_AUTHORITY_VALUE}>{t("DashboardIssuance.wallet.none")}</option>
              {availableWallets.map((wallet) => (
                <option key={wallet.id} value={wallet.publicKey}>
                  {getSignerWalletOptionLabel(wallet, t)}
                </option>
              ))}
            </select>
          </Label>
        ) : (
          <Label className="grid gap-2">
            <span>{t("DashboardIssuance.authority.custom")}</span>
            <Input
              value={newAuthority}
              onChange={(event) => onNewAuthorityChange(event.currentTarget.value)}
              placeholder={t("DashboardIssuance.authority.solanaAddress")}
              pattern={SOLANA_ADDRESS_PATTERN}
              title={t("DashboardIssuance.forms.enterSolanaAddress")}
              required
              autoFocus
            />
          </Label>
        )}

        {isSettingNone ? (
          <p className="text-sm text-[rgba(28,28,29,0.68)]">
            {t("DashboardIssuance.authority.noneWalletWarning")}
          </p>
        ) : null}

        <TokenWalletIdentityCard
          wallet={selectedAuthorityWallet}
          emptyLabel={t("DashboardIssuance.wallet.none")}
          emptyDescription={t("DashboardIssuance.authority.noneDescription")}
        />

        <div className="flex items-center justify-between gap-3 text-sm">
          <p className="text-[rgba(28,28,29,0.68)]">
            {t("DashboardIssuance.authority.controlledWalletHint")}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="h-auto px-0 text-[#1c1c1d]"
            onClick={onToggleMode}
            disabled={isPending}
          >
            {mode === "wallet"
              ? t("DashboardIssuance.authority.useCustom")
              : t("DashboardIssuance.authority.chooseWallet")}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <Label className="grid gap-2">
        <span>{t("DashboardIssuance.authority.new")}</span>
        <Input
          value={newAuthority}
          onChange={(event) => onNewAuthorityChange(event.currentTarget.value)}
          placeholder={t("DashboardIssuance.authority.solanaAddressOrNone")}
          pattern={SOLANA_ADDRESS_PATTERN}
          title={t("DashboardIssuance.authority.enterAddressOrNone")}
          autoFocus
        />
      </Label>

      {authorityWalletsError ? (
        <p className="text-sm text-[#8a1f2a]">{authorityWalletsError}</p>
      ) : (
        <p className="text-sm text-[rgba(28,28,29,0.68)]">
          {t("DashboardIssuance.authority.noWalletsHint")}
        </p>
      )}

      {isSettingNone ? (
        <p className="text-sm text-[rgba(28,28,29,0.68)]">
          {t("DashboardIssuance.authority.noneFieldWarning")}
        </p>
      ) : null}

      <TokenWalletIdentityCard
        wallet={selectedAuthorityWallet}
        publicKey={selectedAuthorityWallet ? null : newAuthority.trim() || null}
        emptyLabel={t("DashboardIssuance.wallet.none")}
        emptyDescription={t("DashboardIssuance.authority.noneDescription")}
      />
    </>
  );
}

function getNoneConfirmationCopy(
  row: PermissionRow,
  t: ReturnType<typeof useTranslations>
): {
  title: string;
  description: string;
  impact: string;
} {
  switch (row.authorityRole) {
    case "mint":
      return {
        title: t("DashboardIssuance.authority.mintNoneTitle"),
        description: t("DashboardIssuance.authority.mintNoneDescription"),
        impact: t("DashboardIssuance.authority.mintNoneImpact"),
      };
    case "freeze":
      return {
        title: t("DashboardIssuance.authority.freezeNoneTitle"),
        description: t("DashboardIssuance.authority.freezeNoneDescription"),
        impact: t("DashboardIssuance.authority.freezeNoneImpact"),
      };
    case "permanentDelegate":
      return {
        title: t("DashboardIssuance.authority.delegateNoneTitle"),
        description: t("DashboardIssuance.authority.delegateNoneDescription"),
        impact: t("DashboardIssuance.authority.delegateNoneImpact"),
      };
    case "metadata":
      return {
        title: t("DashboardIssuance.authority.metadataNoneTitle"),
        description: t("DashboardIssuance.authority.metadataNoneDescription"),
        impact: t("DashboardIssuance.authority.metadataNoneImpact"),
      };
  }
}
