"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

interface CancelTransactionDialogProps {
  open: boolean;
  onKeepGoing: () => void;
  onConfirm: () => void;
}

export function CancelTransactionDialog({
  open,
  onKeepGoing,
  onConfirm,
}: CancelTransactionDialogProps) {
  return (
    <Modal isOpen={open} onClose={onKeepGoing} ariaLabel="Cancel transaction" size="sm">
      <div className="space-y-6 p-6">
        <div className="space-y-2">
          <p className="text-xl font-medium tracking-tight text-text-extra-high">
            Cancel this transaction?
          </p>
          <p className="text-sm text-text-low">
            This transaction has already been started. If you cancel now you'll leave the flow.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onKeepGoing}>
            Keep going
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            Cancel transaction
          </Button>
        </div>
      </div>
    </Modal>
  );
}
