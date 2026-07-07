"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { DeployFeePayment } from "./token-management-workspace.types";
import { TokenSignerSelect } from "./token-signer-select";

interface TokenDeployConfirmationDialogProps {
  isOpen: boolean;
  isPending: boolean;
  feeWallets: PaymentsDashboardWallet[];
  feeWalletId: string;
  feeWalletUnavailableReason: string | null;
  onFeeWalletIdChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: (feePayment: DeployFeePayment) => void;
}

export function TokenDeployConfirmationDialog({
  isOpen,
  isPending,
  feeWallets,
  feeWalletId,
  feeWalletUnavailableReason,
  onFeeWalletIdChange,
  onCancel,
  onConfirm,
}: TokenDeployConfirmationDialogProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      closeDisabled={isPending}
      ariaLabel="Deploy token?"
      closeLabel="Close deploy confirmation modal"
      contentClassName="border-[rgba(28,28,29,0.12)] p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]"
      size="sm"
    >
      <h4 className="pr-12 text-[22px] leading-[1.2] font-medium text-[#1c1c1d]">Deploy token?</h4>
      <p className="mt-2 text-[15px] leading-[1.45] text-[rgba(28,28,29,0.72)]">
        This will submit the deploy transaction on-chain. Kora sponsors the fees, or pay them with
        SOL from the selected fee wallet — the picker only applies to Deploy with Wallet.
      </p>
      <div className="mt-5">
        <TokenSignerSelect
          signerWallets={feeWallets}
          signerWalletId={feeWalletId}
          signerUnavailableReason={feeWalletUnavailableReason}
          onSignerWalletIdChange={onFeeWalletIdChange}
          label="Fee wallet"
        />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button type="button" onClick={() => onConfirm("sponsored")} disabled={isPending}>
          Deploy with Kora
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => onConfirm("wallet")}
          disabled={isPending || !feeWalletId}
        >
          Deploy with Wallet
        </Button>
      </div>
    </Modal>
  );
}
