"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";

export function DisableControlsDialog({
  open,
  walletName,
  submitting,
  onClose,
  onConfirm,
}: {
  open: boolean;
  walletName: string;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  return (
    <Modal
      isOpen={open}
      ariaLabel={t("DashboardCustody.policyDisableTitle")}
      onClose={onClose}
      closeDisabled={submitting}
      size="sm"
    >
      <div className="p-6">
        <h2 className="text-lg font-semibold text-primary">
          {t("DashboardCustody.policyDisableTitle")}
        </h2>
        <p className="mt-2 text-sm leading-6 text-secondary">
          {t("DashboardCustody.policyDisableConfirmation", { wallet: walletName })}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            {t("DashboardCustody.policyCancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={submitting}>
            {t("DashboardCustody.policyConfirmDisable")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
