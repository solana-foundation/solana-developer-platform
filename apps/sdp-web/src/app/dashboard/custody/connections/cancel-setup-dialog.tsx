"use client";

import type { CustodyProvider } from "@sdp/types";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { cancelSetupAction } from "./connection-actions";
import { useCustodyAction } from "./use-custody-action";

/**
 * Abandons a setup that never finished.
 *
 * Kept visibly separate from deactivation, which is the permanent end of a
 * connection that did work. Nothing was created at the provider by an
 * unverified attempt, so there is no residue to reason about: the stored secret
 * is deleted, the row leaves the list, and the user can start again whenever.
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
      // The connection this page is about no longer exists, so staying here
      // would render a 404 on the next read.
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
