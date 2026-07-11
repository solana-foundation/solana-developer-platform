"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import type { ActionConfirmationState } from "./token-management-workspace.types";

interface TokenActionConfirmationDialogProps {
  actionConfirmation: ActionConfirmationState | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TokenActionConfirmationDialog({
  actionConfirmation,
  isPending,
  onCancel,
  onConfirm,
}: TokenActionConfirmationDialogProps) {
  const t = useTranslations();
  if (!actionConfirmation) {
    return null;
  }

  return (
    <Modal
      isOpen={Boolean(actionConfirmation)}
      onClose={onCancel}
      closeDisabled={isPending}
      ariaLabel={actionConfirmation.options.confirmationTitle}
      closeLabel={t("DashboardIssuance.modal.closeConfirmation")}
      contentClassName="border-[rgba(28,28,29,0.12)] p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]"
      size="sm"
    >
      <h4 className="pr-12 text-[22px] leading-[1.2] font-medium text-[#1c1c1d]">
        {actionConfirmation.options.confirmationTitle}
      </h4>
      <p className="mt-2 text-[15px] leading-[1.45] text-[rgba(28,28,29,0.72)]">
        {actionConfirmation.options.confirmationDescription}
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          {t("DashboardIssuance.confirmation.notNow")}
        </Button>
        <Button type="button" onClick={onConfirm} disabled={isPending}>
          {actionConfirmation.options.confirmButtonLabel}
        </Button>
      </div>
    </Modal>
  );
}
