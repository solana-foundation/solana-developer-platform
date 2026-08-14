"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";

export interface WebhookConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

// Small confirm dialog shared by rotate / disable / delete (the workflows-tab
// ConfirmDialog shape).
export function ConfirmWebhookActionModal({
  confirm,
  pending,
  onCancel,
}: {
  confirm: WebhookConfirmState | null;
  pending: boolean;
  onCancel: () => void;
}) {
  const t = useTranslations();
  if (!confirm) {
    return null;
  }
  return (
    <Modal
      isOpen
      onClose={onCancel}
      closeDisabled={pending}
      ariaLabel={confirm.title}
      closeLabel={t("DashboardWebhooks.close")}
      contentClassName="border-border-default p-5"
      size="sm"
    >
      <h4 className="pr-12 text-lg font-medium text-primary">{confirm.title}</h4>
      <p className="mt-2 text-sm text-secondary">{confirm.description}</p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={pending}>
          {t("DashboardWebhooks.cancel")}
        </Button>
        <Button
          type="button"
          variant={confirm.destructive ? "destructive" : "default"}
          size="sm"
          onClick={confirm.onConfirm}
          disabled={pending}
        >
          {confirm.confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
