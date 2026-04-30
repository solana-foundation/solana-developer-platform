"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { deactivateApiKeyInlineAction } from "./actions";

interface DeleteApiKeyModalProps {
  keyId: string;
  keyName: string;
  renderTrigger?: (open: () => void) => ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onDeleted?: () => void;
}

export function DeleteApiKeyModal({
  keyId,
  keyName,
  renderTrigger,
  open: isOpenProp,
  onOpenChange,
  onDeleted,
}: DeleteApiKeyModalProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isControlled = isOpenProp !== undefined;
  const isOpen = isControlled ? isOpenProp : uncontrolledOpen;

  useEffect(() => {
    if (!isOpen) {
      setConfirmation("");
      setIsSubmitting(false);
    }
  }, [isOpen]);

  const openModal = () => {
    if (isControlled) {
      onOpenChange?.(true);
      return;
    }

    setUncontrolledOpen(true);
  };

  const close = () => {
    if (isControlled) {
      onOpenChange?.(false);
      return;
    }

    setUncontrolledOpen(false);
  };

  const canSubmit = confirmation.trim() === keyName.trim();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    const toastId = toast.loading("Deleting API key.", {
      position: "bottom-right",
    });

    const result = await deactivateApiKeyInlineAction({
      keyId,
      keyName,
      confirmation,
    }).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : "Unable to delete API key.",
    }));

    if (result.ok) {
      close();
      toast.success(result.message, { id: toastId, position: "bottom-right" });
      onDeleted?.();
      return;
    }

    setIsSubmitting(false);
    toast.error(result.message, { id: toastId, position: "bottom-right" });
  };

  return (
    <>
      {renderTrigger ? (
        renderTrigger(openModal)
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="border-[#c71f37] text-[#c71f37] hover:bg-[#c71f37]/10"
          onClick={openModal}
        >
          Delete
        </Button>
      )}

      <Modal
        isOpen={isOpen}
        onClose={close}
        ariaLabel="Delete API key"
        closeLabel="Close confirmation modal"
        closeDisabled={isSubmitting}
        contentClassName="rounded-xl p-5 text-left"
        size="sm"
      >
        <p className="pr-10 text-sm font-medium text-[#1c1c1d]">Delete API key</p>
        <p className="mt-2 text-sm text-[rgba(28,28,29,0.72)]">
          This removes the key without deleting the row.
        </p>
        <p className="mt-2 text-sm">
          Type <span className="font-mono font-medium">{keyName}</span> to confirm.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <input type="hidden" name="keyId" value={keyId} />
          <input type="hidden" name="keyName" value={keyName} />
          <Label htmlFor={`confirm-${keyId}`} className="text-sm">
            Confirm key name
          </Label>
          <Input
            id={`confirm-${keyId}`}
            name="confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            placeholder="Paste exact key name"
            autoFocus
            autoComplete="off"
            disabled={isSubmitting}
          />

          <DeleteApiKeyFormActions
            canSubmit={canSubmit}
            onCancel={close}
            isSubmitting={isSubmitting}
          />
        </form>
      </Modal>
    </>
  );
}

function DeleteApiKeyFormActions({
  canSubmit,
  onCancel,
  isSubmitting,
}: {
  canSubmit: boolean;
  onCancel: () => void;
  isSubmitting: boolean;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button
        type="submit"
        variant="destructive"
        disabled={!canSubmit || isSubmitting}
        aria-busy={isSubmitting}
        className="min-w-[104px]"
      >
        {isSubmitting ? "Deleting..." : "Delete key"}
      </Button>
    </div>
  );
}
