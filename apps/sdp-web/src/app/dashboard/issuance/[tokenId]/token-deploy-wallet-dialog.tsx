"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { TokenSignerSelect } from "./token-signer-select";

interface TokenDeployWalletDialogProps {
  isOpen: boolean;
  isPending: boolean;
  signerWallets: PaymentsDashboardWallet[];
  signerUnavailableReason: string | null;
  signingCustodyWalletId: string;
  onSigningCustodyWalletIdChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TokenDeployWalletDialog({
  isOpen,
  isPending,
  signerWallets,
  signerUnavailableReason,
  signingCustodyWalletId,
  onSigningCustodyWalletIdChange,
  onCancel,
  onConfirm,
}: TokenDeployWalletDialogProps) {
  const t = useTranslations();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      closeDisabled={isPending}
      ariaLabel={t("DashboardIssuance.management.deployToken")}
      closeLabel={t("DashboardIssuance.modal.close")}
      contentClassName="border-border-default p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]"
      size="sm"
    >
      <h4 className="pr-12 text-[22px] leading-[1.2] font-medium text-primary">
        {t("DashboardIssuance.management.deployToken")}
      </h4>
      <div className="mt-5">
        <TokenSignerSelect
          signerWallets={signerWallets}
          signerWalletId={signingCustodyWalletId}
          signerUnavailableReason={signerUnavailableReason}
          onSignerWalletIdChange={onSigningCustodyWalletIdChange}
          showSelectionSummary={Boolean(signingCustodyWalletId)}
        />
      </div>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          {t("DashboardIssuance.confirmation.notNow")}
        </Button>
        <Button
          type="button"
          onClick={onConfirm}
          disabled={isPending || !signingCustodyWalletId || Boolean(signerUnavailableReason)}
        >
          {t("DashboardIssuance.management.deployToken")}
        </Button>
      </div>
    </Modal>
  );
}
