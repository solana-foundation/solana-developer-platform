"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";

interface CancelTransactionDialogProps {
  open: boolean;
  onKeepGoing: () => void;
  onCancel: () => void;
}

export function CancelTransactionDialog({
  open,
  onKeepGoing,
  onCancel,
}: CancelTransactionDialogProps) {
  const t = useTranslations();
  return (
    <Modal
      isOpen={open}
      onClose={onKeepGoing}
      ariaLabel={t("DashboardPayments.cancelTransaction.ariaLabel")}
      size="sm"
    >
      <div className="space-y-6 p-6">
        <div className="space-y-2">
          <p className="text-xl font-medium tracking-tight text-text-extra-high">
            {t("DashboardPayments.cancelTransaction.title")}
          </p>
          <p className="text-sm text-text-low">
            {t("DashboardPayments.cancelTransaction.description")}
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onKeepGoing}>
            {t("DashboardPayments.cancelTransaction.keepGoing")}
          </Button>
          <Button type="button" variant="destructive" onClick={onCancel}>
            {t("DashboardPayments.cancelTransaction.cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
