"use client";

import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";

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
  const t = useTranslations();
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
      ariaLabel={t("DashboardPayments.counterparty.deleteCounterparty")}
      onClose={deleting ? undefined : onClose}
      size="sm"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-medium tracking-tight text-text-extra-high">
            {t("DashboardPayments.counterparty.deleteCounterparty")}
          </h2>
          <p className="text-sm text-text-medium">
            {displayName ? (
              t("DashboardPayments.counterparty.deleteNamedCounterparty", { name: displayName })
            ) : (
              t("DashboardPayments.counterparty.deleteThisCounterparty")
            )}
          </p>
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={deleting}>
            {t("DashboardPayments.counterparty.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={deleting}
            iconLeft={deleting ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {deleting
              ? t("DashboardPayments.counterparty.deleting")
              : t("DashboardPayments.counterparty.delete")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
