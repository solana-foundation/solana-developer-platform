"use client";

import type { CustodyProvider } from "@sdp/types";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { cancelSetupAction } from "./connection-actions";
import { useCustodyAction } from "./use-custody-action";

/**
 * Cancels unfinished setup, retaining the deactivated connection for history.
 * Stored-secret cleanup may finish after the cancellation succeeds.
 */
export function CancelSetupDialog({
  isOpen,
  onClose,
  connectionId,
  label,
  provider,
}: {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string;
  label: string;
  provider: CustodyProvider;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { pending, run } = useCustodyAction();

  const handleConfirm = async () => {
    const result = await run(() => cancelSetupAction(connectionId, provider), {
      successTitle: t("DashboardCustody.cancelSetupSuccessTitle"),
      successDescription: t("DashboardCustody.cancelSetupSuccessDescription"),
      failedTitle: t("DashboardCustody.cancelSetupFailedTitle"),
      unknownTitle: t("DashboardCustody.cancelSetupUnknownTitle"),
    });
    if (result.status === "success") {
      onClose();
      // Return to the list, where the connection remains as Deactivated.
      router.push(`/dashboard/integrations/${provider}`);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={pending ? undefined : onClose}
      closeDisabled={pending}
      size="lg"
      ariaLabel={t("DashboardCustody.cancelSetupTitle", { label })}
    >
      <div className="space-y-4 p-6" data-custody-cancel-setup-dialog>
        <h2 className="text-lg font-medium text-primary">
          {t("DashboardCustody.cancelSetupTitle", { label })}
        </h2>
        <p className="text-sm leading-6 text-secondary">
          {t("DashboardCustody.cancelSetupExplainer")}
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {t("DashboardCustody.cancelSetupKeep")}
          </Button>
          <Button type="button" variant="destructive" onClick={handleConfirm} disabled={pending}>
            {t("DashboardCustody.cancelSetupConfirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
