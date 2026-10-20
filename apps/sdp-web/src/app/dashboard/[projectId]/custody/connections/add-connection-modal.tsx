"use client";

import { isByokCustodyProvider } from "@sdp/types/custody";
import { Button } from "@sdp/ui/button";
import { Modal } from "@sdp/ui/modal";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { ByokCredentialForm } from "@/app/dashboard/[projectId]/custody/setup/privy-credential-form";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";

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
  const href = useProjectHref();
  const formId = useId();
  const [ready, setReady] = useState(provider !== "fireblocks");
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
      href(`/dashboard/integrations/${provider}/connections/${encodeURIComponent(connectionId)}`)
    );
  };

  if (!isByokCustodyProvider(provider)) return null;

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

        <ByokCredentialForm
          provider={provider}
          formId={formId}
          onSuccess={handleSuccess}
          onReadyChange={setReady}
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
              disabled={submitting || !ready}
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
