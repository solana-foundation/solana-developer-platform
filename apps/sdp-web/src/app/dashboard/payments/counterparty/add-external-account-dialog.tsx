"use client";

import type { CounterpartyAccount } from "@sdp/types";
import { Modal } from "@/components/ui/modal";
import { CryptoAccountForm } from "./crypto-account-form";

interface AddExternalAccountDialogProps {
  isOpen: boolean;
  counterpartyId: string;
  onAdded: (account: CounterpartyAccount) => void;
  onClose: () => void;
}

export function AddExternalAccountDialog({
  isOpen,
  counterpartyId,
  onAdded,
  onClose,
}: AddExternalAccountDialogProps) {
  return (
    <Modal isOpen={isOpen} ariaLabel="Add external account" onClose={onClose} size="md">
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-medium tracking-tight text-text-extra-high">
            Add external account
          </h2>
          <p className="text-sm text-text-medium">
            Attach a crypto wallet for this counterparty. The address is screened for risk before
            it's added.
          </p>
        </div>
        <CryptoAccountForm
          counterpartyId={counterpartyId}
          onAdded={(account) => {
            onAdded(account);
            onClose();
          }}
        />
      </div>
    </Modal>
  );
}
