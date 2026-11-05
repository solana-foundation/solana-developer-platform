"use client";

import type { ByokCustodyProvider } from "@sdp/types/custody";
import { Button } from "@sdp/ui/button";
import { PlugIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useSelectedProjectName } from "@/app/(session)/dashboard/[projectId]/wallets/connections/use-selected-project-name";
import { formatCustodyProviderName } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { ByokCredentialForm } from "@/app/(session)/dashboard/[projectId]/wallets/setup/privy-credential-form";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { WizardFrame } from "@/components/wizard-frame";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";

/**
 * Connects another provider account to this project, as its own page.
 *
 * The form itself is the setup wizard's, unchanged: it owns the idempotency
 * key, the frozen-payload replay, and the whole recovery state machine for
 * submissions whose outcome is unknown. Reimplementing any of that here would
 * mean two versions of the one piece of logic that must never duplicate a
 * credential, so the page only supplies the frame and where to go afterwards.
 *
 * Cancel is refused while a request is in flight or recovery is locked: the
 * exact payload needed to replay an unknown submission lives in the form.
 */
export function AddConnectionFlow({ provider }: { provider: ByokCustodyProvider }) {
  const t = useTranslations();
  const router = useRouter();
  const href = useProjectHref();
  const projectName = useSelectedProjectName();
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
  const leaveDisabled = submitting || recoveryLocked;
  const providerHref = href(`/dashboard/integrations/${provider}`);
  const createsWallet = provider === "privy";
  const providerName = formatCustodyProviderName(provider);

  const handleSuccess = (connectionId: string) => {
    setSubmitting(false);
    setInRecovery(false);
    setRecoveryLocked(false);
    router.push(
      href(`/dashboard/integrations/${provider}/connections/${encodeURIComponent(connectionId)}`)
    );
  };

  const footer = (
    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-8">
      <p className="max-w-md text-body text-secondary">
        {t(
          createsWallet
            ? "DashboardCustody.addConnectionFooterWithWallet"
            : "DashboardCustody.addConnectionFooter",
          { provider: providerName, project: projectName }
        )}
      </p>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={leaveDisabled}
          onClick={() => router.push(providerHref)}
        >
          {inRecovery ? t("DashboardCustody.close") : t("DashboardCustody.cancel")}
        </Button>
        {inRecovery ? null : (
          <Button
            type="submit"
            form={formId}
            disabled={!ready}
            loading={submitting}
            iconLeft={createsWallet ? <PlugIcon aria-hidden className="size-4" /> : undefined}
          >
            {t(
              createsWallet
                ? "DashboardCustody.byokConnectAndCreateWallet"
                : "DashboardCustody.byokConnect"
            )}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <WizardFrame
      steps={[{ label: t("DashboardCustody.addConnection"), title: "" }]}
      currentStep={0}
      hideProgress
      progressLabel={t("DashboardCustody.addConnection")}
      footer={footer}
    >
      {/* The header's Back follows the same lock as Cancel: leaving unmounts the form, and with
          it the payload and key an unknown submission needs to replay safely. */}
      <DashboardPageTitle
        title={t("DashboardCustody.newConnectionTitle", { provider: providerName })}
        backLocked={leaveDisabled ? true : undefined}
      />
      <div data-custody-add-connection>
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
      </div>
    </WizardFrame>
  );
}
