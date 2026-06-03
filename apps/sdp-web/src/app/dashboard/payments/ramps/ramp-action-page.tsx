"use client";

import type { ComplianceProviderId, PaymentsDashboardWallet, RampProviderId } from "@sdp/types";
import type { CounterpartiesResult } from "@/app/dashboard/payments/payments-workspace.data";
import { OfframpStepContent } from "./components/offramp-step-content";
import { OnrampStepContent } from "./components/onramp-step-content";
import { PoweredByRampProvider, RampWizardShell } from "./components/ramp-wizard-shell";
import { OFFRAMP_STEPS, useOfframpWizard } from "./hooks/use-offramp-wizard";
import { ONRAMP_STEPS, useOnrampWizard } from "./hooks/use-onramp-wizard";

interface PaymentsActionPageProps {
  mode: "send" | "receive";
  actionLabel?: string;
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  enabledComplianceProviders: ComplianceProviderId[];
  enabledRampProviders: RampProviderId[];
  counterpartiesResult: CounterpartiesResult;
}

function OnrampFlow(props: PaymentsActionPageProps) {
  const wizard = useOnrampWizard(props);
  const {
    stepIndex,
    currentStepId,
    isLastStep,
    canProceed,
    liveWalletsError,
    walletsLoading,
    quote,
    hostedQuoteLoading,
    counterpartyDialogOpen,
    setCounterpartyDialogOpen,
    handlePrimary,
    handleSecondary,
    handleCounterpartyCreated,
  } = wizard;

  return (
    <RampWizardShell
      steps={ONRAMP_STEPS}
      stepIndex={stepIndex}
      primaryDisabled={
        hostedQuoteLoading || !canProceed || (currentStepId === "DEPOSIT" && walletsLoading)
      }
      primaryLabel={hostedQuoteLoading ? "Opening..." : isLastStep ? "Done" : "Next"}
      walletsError={liveWalletsError}
      onPrimary={() => void handlePrimary()}
      onSecondary={handleSecondary}
      counterpartyDialogOpen={counterpartyDialogOpen}
      setCounterpartyDialogOpen={setCounterpartyDialogOpen}
      onCounterpartyCreated={handleCounterpartyCreated}
      footer={
        currentStepId === "PROVIDER" && quote ? (
          <PoweredByRampProvider provider={quote.provider} />
        ) : null
      }
    >
      <OnrampStepContent wizard={wizard} />
    </RampWizardShell>
  );
}

function OfframpFlow(props: PaymentsActionPageProps) {
  const wizard = useOfframpWizard(props);
  const {
    stepIndex,
    currentStepId,
    isLastStep,
    canProceed,
    liveWalletsError,
    walletsLoading,
    quote,
    hostedQuoteLoading,
    counterpartyDialogOpen,
    setCounterpartyDialogOpen,
    handlePrimary,
    handleSecondary,
    handleCounterpartyCreated,
  } = wizard;

  return (
    <RampWizardShell
      steps={OFFRAMP_STEPS}
      stepIndex={stepIndex}
      primaryDisabled={
        hostedQuoteLoading || !canProceed || (currentStepId === "WITHDRAW" && walletsLoading)
      }
      primaryLabel={hostedQuoteLoading ? "Opening..." : isLastStep ? "Done" : "Next"}
      walletsError={liveWalletsError}
      onPrimary={() => void handlePrimary()}
      onSecondary={handleSecondary}
      counterpartyDialogOpen={counterpartyDialogOpen}
      setCounterpartyDialogOpen={setCounterpartyDialogOpen}
      onCounterpartyCreated={handleCounterpartyCreated}
      footer={
        currentStepId === "COMPLETE" && quote ? (
          <PoweredByRampProvider provider={quote.provider} />
        ) : null
      }
    >
      <OfframpStepContent wizard={wizard} />
    </RampWizardShell>
  );
}

export function PaymentsActionPage(props: PaymentsActionPageProps) {
  if (props.mode === "send") {
    return <OfframpFlow {...props} />;
  }
  return <OnrampFlow {...props} />;
}
