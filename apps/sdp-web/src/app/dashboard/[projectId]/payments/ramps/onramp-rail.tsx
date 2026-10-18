"use client";

import { Button } from "@sdp/ui/button";
import Link from "next/link";
import { WizardSummaryList } from "@/app/dashboard/[projectId]/payments/wizard-summary-list";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { OnrampStepContent } from "./components/onramp-step-content";
import { ProviderSummaryTrigger } from "./components/provider-summary-trigger";
import { RampStatusInline } from "./components/ramp-status-panel";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { useOnrampWizard } from "./hooks/use-onramp-wizard";
import type { RailProps } from "./ramp-action-page";
import { getRampTransferState } from "./ramp-transfer-state";
import { preStepSummaryDetails } from "./wizard-summary";

export function OnrampRail({
  wallets,
  walletsError,
  enabledRampProviders,
  rampProviderAccess,
  counterpartiesResult,
  selectedCounterparty,
  counterpartyId,
  counterpartyName,
  methodLabel,
  preSteps,
  onExit,
}: RailProps) {
  const t = useTranslations();
  const href = useProjectHref();
  const wizard = useOnrampWizard({
    wallets,
    walletsError,
    enabledRampProviders,
    rampProviderAccess,
    counterpartiesResult,
    selectedCounterparty,
    initialCounterpartyId: counterpartyId,
    onExit,
  });

  const summaryDetails = [
    ...preStepSummaryDetails(t, counterpartyName, methodLabel),
    ...wizard.summaryDetails,
  ];
  const hostedStage = wizard.onTransactionStage && wizard.quote?.deliveryMode === "hosted";
  const showInlineStatus = wizard.onTransactionStage && Boolean(wizard.quote);
  const transferState =
    wizard.transferStatus === undefined ? null : getRampTransferState(wizard.transferStatus.status);
  return (
    <RampWizardShell
      steps={[...preSteps, ...wizard.steps]}
      stepIndex={preSteps.length + wizard.stepIndex}
      completionTitle={
        wizard.transferStatus?.status === "completed"
          ? t("DashboardPayments.ramps.depositComplete")
          : undefined
      }
      primaryDisabled={
        wizard.hostedQuoteLoading ||
        !wizard.canProceed ||
        (wizard.currentStepId === "DEPOSIT" && wizard.walletsLoading)
      }
      primaryLabel={
        wizard.hostedQuoteLoading
          ? t("DashboardPayments.processing")
          : t("DashboardPayments.counterparty.next")
      }
      walletsError={wizard.liveWalletsError}
      onPrimary={wizard.isLastStep ? wizard.finish : () => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      counterpartyDialog={null}
      summary={
        wizard.fields.provider === null ? undefined : <WizardSummaryList details={summaryDetails} />
      }
      summaryTrigger={
        wizard.fields.provider === null ? undefined : (
          <ProviderSummaryTrigger provider={wizard.fields.provider} />
        )
      }
      header={
        showInlineStatus ? (
          <RampStatusInline
            direction="onramp"
            hosted={hostedStage}
            transfer={wizard.transferStatus}
          />
        ) : undefined
      }
      secondaryLabel={
        wizard.onTransactionStage && transferState?.cancelable
          ? t("DashboardPayments.counterparty.cancel")
          : undefined
      }
      confirmSecondary={wizard.onTransactionStage && transferState?.cancelable === true}
      secondaryDisabled={wizard.isCanceling || wizard.hostedQuoteLoading || wizard.quoteInFlight}
      hideSecondary={
        wizard.onTransactionStage && transferState !== null && !transferState.cancelable
      }
      footerActions={
        transferState?.terminal ? (
          <Button asChild type="button">
            <Link href={href(`/dashboard/payments/counterparty/${wizard.fields.counterpartyId}`)}>
              {t("DashboardPayments.goToTransaction")}
            </Link>
          </Button>
        ) : null
      }
      hidePrimary={wizard.currentStepId === "PROVIDER"}
    >
      <OnrampStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
