"use client";

import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { PrivyCredentialForm } from "@/app/dashboard/custody/setup/privy-credential-form";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";

/**
 * Connects another provider account to this project.
 *
 * The form itself is the setup wizard's, unchanged: it owns the idempotency
 * key, the frozen-payload replay, and the whole recovery state machine for
 * submissions whose outcome is unknown. Reimplementing any of that here would
 * mean two versions of the one piece of logic that must never duplicate a
 * credential, so the modal only supplies the frame and where to go afterwards.
 *
 * Closing is refused while a request is in flight or recovery is locked: the
 * exact payload needed to replay an unknown submission lives in the form.
 */
export function AddConnectionModal({
  isOpen,
  onClose,
  provider,
}: {
  isOpen: boolean;
  onClose: () => void;
  provider: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const formId = useId();
  const [submitting, setSubmitting] = useState(false);
  // Once the form has swapped its fields for a recovery panel there is no
  // `<form id={formId}>` left for this footer to submit, and the panel carries
  // the only action that can still converge. Keeping the primary on screen gave
  // the user a live-looking button that did nothing when Privy stopped
  // answering — exactly when they most needed the one that works.
  const [inRecovery, setInRecovery] = useState(false);
  const [recoveryLocked, setRecoveryLocked] = useState(false);
  const closeDisabled = submitting || recoveryLocked;

  const handleClose = () => {
    if (closeDisabled) return;
    setInRecovery(false);
    onClose();
  };

  const handleSuccess = (connectionId: string) => {
    setSubmitting(false);
    setInRecovery(false);
    setRecoveryLocked(false);
    onClose();
    router.push(
      `/dashboard/integrations/${provider}/connections/${encodeURIComponent(connectionId)}`
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      closeDisabled={closeDisabled}
      size="lg"
      ariaLabel={t("DashboardCustody.addConnection")}
    >
      <div className="space-y-5 p-6" data-custody-add-connection-modal>
        <div className="space-y-1">
          <h2 className="text-lg font-medium text-primary">
            {t("DashboardCustody.addConnection")}
          </h2>
          <p className="text-sm text-tertiary">{t("DashboardCustody.addConnectionDescription")}</p>
        </div>

        <PrivyCredentialForm
          formId={formId}
          onSuccess={handleSuccess}
          onPendingChange={setSubmitting}
          onRecoveryChange={setInRecovery}
          onRecoveryLockChange={setRecoveryLocked}
          showSubmitButton={false}
        />

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose} disabled={closeDisabled}>
            {inRecovery ? t("DashboardCustody.close") : t("DashboardCustody.cancel")}
          </Button>
          {inRecovery ? null : (
            <Button
              type="submit"
              form={formId}
              disabled={submitting}
              iconLeft={
                submitting ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : undefined
              }
            >
              {submitting ? t("DashboardCustody.byokChecking") : t("DashboardCustody.byokConnect")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
