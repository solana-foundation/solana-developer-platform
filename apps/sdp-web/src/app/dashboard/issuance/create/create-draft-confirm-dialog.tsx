"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

interface CreateDraftConfirmDialogProps {
  open: boolean;
  assetName: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

// The same key press (or click) that opens this dialog can leak through to the
// autoFocused Confirm button below — e.g. holding Enter a beat too long fires
// OS key-repeat, and the repeat keydown lands on Confirm the instant it gains
// focus, "confirming" before the user ever saw the dialog. Ignore activations
// in this brief window after opening; a genuinely deliberate second press
// still lands well outside it.
const LEAK_THROUGH_GUARD_MS = 350;

// Classic "are you sure?" gate for the Create-draft action, so it never fires
// from a stray Enter — creating a draft persists it and navigates the user out
// of the wizard, so it stays a deliberate confirmation.
export function CreateDraftConfirmDialog({
  open,
  assetName,
  submitting,
  onCancel,
  onConfirm,
}: CreateDraftConfirmDialogProps) {
  const name = assetName.trim();
  const openedAtRef = useRef(Infinity);

  useEffect(() => {
    if (open) {
      openedAtRef.current = performance.now();
    }
  }, [open]);

  const handleConfirm = () => {
    if (performance.now() - openedAtRef.current < LEAK_THROUGH_GUARD_MS) {
      return;
    }
    onConfirm();
  };

  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      ariaLabel="Create asset draft"
      size="sm"
      closeDisabled={submitting}
    >
      <div className="space-y-6 p-6">
        <div className="space-y-2">
          <p className="text-xl font-medium tracking-tight text-primary">
            Create this asset draft?
          </p>
          <p className="text-sm text-tertiary">
            This creates a draft
            {name ? (
              <>
                {" "}
                of <span className="font-medium text-primary">{name}</span>
              </>
            ) : null}
            . You can keep editing it and publish when you&apos;re ready.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          {/* Focus the primary action on open so Enter confirms straight away
              (a stray Enter still only *opens* the dialog — this is the second,
              deliberate press). */}
          <Button type="button" autoFocus onClick={handleConfirm} disabled={submitting}>
            {submitting ? "Creating…" : "Create draft"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
