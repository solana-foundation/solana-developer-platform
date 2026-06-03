"use client";

import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

interface DeleteCounterpartyDialogProps {
  isOpen: boolean;
  displayName: string | null;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function DeleteCounterpartyDialog({
  isOpen,
  displayName,
  onConfirm,
  onClose,
}: DeleteCounterpartyDialogProps) {
  const [deleting, setDeleting] = useState(false);

  async function handleConfirm() {
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      ariaLabel="Delete counterparty"
      onClose={deleting ? undefined : onClose}
      size="sm"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-medium tracking-tight text-text-extra-high">
            Delete counterparty
          </h2>
          <p className="text-sm text-text-medium">
            {displayName ? (
              <>
                Are you sure you want to delete <span className="font-medium">{displayName}</span>?
                This will archive the counterparty and its accounts.
              </>
            ) : (
              "Are you sure you want to delete this counterparty?"
            )}
          </p>
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={deleting}
            iconLeft={deleting ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {deleting ? "Deleting" : "Delete"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
