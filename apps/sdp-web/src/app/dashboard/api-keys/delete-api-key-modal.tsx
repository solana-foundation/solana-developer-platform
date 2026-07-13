"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
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
  const t = useTranslations();
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
    const toastId = toast.loading(t("DashboardCustody.deleting"), {
      position: "bottom-right",
    });

    const result = await deactivateApiKeyInlineAction({
      keyId,
      keyName,
      confirmation,
    }).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : t("DashboardCustody.deleteApiKey"),
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
          className="border-destructive text-destructive hover:bg-destructive/10"
          onClick={openModal}
        >
          {t("DashboardCustody.delete")}
        </Button>
      )}

      <Modal
        isOpen={isOpen}
        onClose={close}
        ariaLabel={t("DashboardCustody.deleteApiKey")}
        closeLabel={t("DashboardCustody.closeConfirmationModal")}
        closeDisabled={isSubmitting}
        contentClassName="rounded-xl p-5 text-left"
        size="sm"
      >
        <p className="pr-10 text-sm font-medium text-primary">
          {t("DashboardCustody.deleteApiKey")}
        </p>
        <p className="mt-2 text-sm text-secondary">
          {t("DashboardCustody.deleteApiKeyDescription")}
        </p>
        <p className="mt-2 text-sm">
          {t("DashboardCustody.typeKeyNameToConfirm", { name: keyName })}
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <input type="hidden" name="keyId" value={keyId} />
          <input type="hidden" name="keyName" value={keyName} />
          <Label htmlFor={`confirm-${keyId}`} className="text-sm">
            {t("DashboardCustody.confirmKeyName")}
          </Label>
          <Input
            id={`confirm-${keyId}`}
            name="confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            placeholder={t("DashboardCustody.deleteApiKeyPlaceholder")}
            autoFocus
            autoComplete="off"
            disabled={isSubmitting}
          />

          <DeleteApiKeyFormActions
            canSubmit={canSubmit}
            onCancel={close}
            isSubmitting={isSubmitting}
            t={t}
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
  t,
}: {
  canSubmit: boolean;
  onCancel: () => void;
  isSubmitting: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>
        {t("DashboardCustody.cancel")}
      </Button>
      <Button
        type="submit"
        variant="destructive"
        disabled={!canSubmit || isSubmitting}
        aria-busy={isSubmitting}
        className="min-w-[104px]"
      >
        {isSubmitting ? t("DashboardCustody.deleting") : t("DashboardCustody.deleteKey")}
      </Button>
    </div>
  );
}
