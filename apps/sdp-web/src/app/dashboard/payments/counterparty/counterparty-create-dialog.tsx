"use client";

import type { Counterparty } from "@sdp/types";
import { Modal } from "@/components/ui/modal";
import { CounterpartyCreateProvider } from "./counterparty-create-context";
import { CounterpartyCreatePage } from "./counterparty-create-page";

interface CounterpartyCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (counterparty: Counterparty) => void;
}

export function CounterpartyCreateDialog({
  open,
  onClose,
  onCreated,
}: CounterpartyCreateDialogProps) {
  return (
    <Modal isOpen={open} onClose={onClose} ariaLabel="Add counterparty" size="lg">
      <div className="px-6 pt-12 pb-6">
        <CounterpartyCreateProvider onCreated={onCreated}>
          <CounterpartyCreatePage />
        </CounterpartyCreateProvider>
      </div>
    </Modal>
  );
}
