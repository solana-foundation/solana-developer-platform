"use client";

import { TriangleAlert } from "lucide-react";
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
      contentClassName="border-border-default p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]"
      size={actionConfirmation.options.confirmationWarning ? "md" : "sm"}
    >
      <h4 className="pr-12 text-[22px] leading-[1.2] font-medium text-primary">
        {actionConfirmation.options.confirmationTitle}
      </h4>
      {actionConfirmation.options.confirmationWarning ? (
        <div
          role="alert"
          className="mt-4 flex items-start gap-3 rounded-xl border border-destructive-border bg-destructive-bg p-4 text-destructive-strongest"
        >
          <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p className="text-sm font-medium leading-relaxed">
            {actionConfirmation.options.confirmationWarning}
          </p>
        </div>
      ) : null}
      {actionConfirmation.options.confirmationDetails ? (
        <dl className="mt-4 divide-y divide-border-subtle text-sm">
          {actionConfirmation.options.confirmationDetails.map(({ label, value }) => (
            <div key={label} className="flex justify-between gap-4 py-3">
              <dt className="shrink-0 text-tertiary">{label}</dt>
              <dd className="min-w-0 break-all text-right text-primary">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-[15px] leading-[1.45] text-secondary">
          {actionConfirmation.options.confirmationDescription}
        </p>
      )}
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
